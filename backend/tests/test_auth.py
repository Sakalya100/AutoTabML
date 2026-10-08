"""Clerk sign-in: token verification against a locally generated RSA key (no network), the 401s a signed-out caller
gets, the per-user rate limit, and claiming an anonymous browser's sessions on the first signed-in request."""

from __future__ import annotations

import base64
import time
from typing import Any

import jwt
import pytest
from conftest import run_async
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from autotinker_api import auth, db

HOST = "foo-bar-12.clerk.accounts.dev"
PK = "pk_test_" + base64.b64encode(f"{HOST}$".encode()).decode().rstrip("=")
USER = "user_2abcDEFghiJKLmnoPQR"
ORIGIN = "http://localhost:3000"


def _keypair() -> tuple[Any, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return key, pem.decode()


SIGNING_KEY, PUBLIC_PEM = _keypair()
OTHER_KEY, _ = _keypair()


def token(sub: str = USER, *, key: Any = None, exp_in: int = 60, nbf_in: int = -5, **claims: Any) -> str:
    now = int(time.time())
    body = {"sub": sub, "iat": now, "nbf": now + nbf_in, "exp": now + exp_in, "azp": ORIGIN, "sid": "sess_1", **claims}
    return jwt.encode(body, key or SIGNING_KEY, algorithm="RS256", headers={"kid": "ins_test"})


def bearer(tok: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture()
def clerk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", PK)
    monkeypatch.setenv("CLERK_JWT_KEY", PUBLIC_PEM.replace("\n", "\\n"))  # as a one-line env value


@pytest.fixture(autouse=True)
def public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    import autotinker_api.urlguard as guard

    monkeypatch.setattr(guard, "system_resolve", lambda host: ["93.184.216.34"])


def start(client: TestClient, headers: dict[str, str] | None = None) -> Any:
    body = {"url": "https://data.example/BreastCancer.csv", "target": "Class", "maxExperiments": 3}
    return client.post("/api/runs", json=body, headers=headers or {})


# ------------------------------------------------------------------------------------------------------ config


def test_publishable_key_decodes_to_the_frontend_api() -> None:
    assert auth.frontend_api_from_key(PK) == HOST
    live = "pk_live_" + base64.b64encode(b"clerk.example.com$").decode()
    assert auth.frontend_api_from_key(live) == "clerk.example.com"
    for bad in ("sk_test_abc", "pk_test_!!!", "pk_test_"):
        with pytest.raises(ValueError):
            auth.frontend_api_from_key(bad)


def test_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    assert auth.config() is None and auth.mode() == "anonymous"
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", PK)
    cfg = auth.config()
    assert cfg is not None and auth.mode() == "clerk"
    assert cfg.jwks_url == f"https://{HOST}/.well-known/jwks.json" and cfg.jwt_key is None
    monkeypatch.setenv("AUTOTINKER_PUBLIC_URL", "https://autotinker.example/some/path")
    assert auth.authorized_parties(cfg, "https://preview.example") == (
        "https://autotinker.example",
        "https://preview.example",
        ORIGIN,
    )
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://a.example/, https://b.example")
    cfg = auth.config()
    assert cfg is not None and auth.authorized_parties(cfg, "https://preview.example") == (
        "https://a.example",
        "https://b.example",
    )


# ---------------------------------------------------------------------------------------------------- verify


def _verify(tok: str, parties: tuple[str, ...] = (ORIGIN,)) -> str:
    cfg = auth.ClerkConfig(frontend_api=HOST, jwt_key=PUBLIC_PEM, authorized_parties=None)
    return str(run_async(auth.verify_token(tok, cfg, parties)))


def test_verify_token() -> None:
    assert _verify(token()) == USER
    assert _verify(token(exp_in=-2)) == USER  # within the 5 s leeway
    assert _verify(token(azp=None)) == USER  # no azp: nothing to check
    bad = [
        token(exp_in=-30),  # expired
        token(nbf_in=30),  # not yet valid
        token(key=OTHER_KEY),  # signed by someone else
        token(azp="https://evil.example"),
        token(sub="o-AAAAAAAAAAAAAAAAAAAAAAAA"),  # not a Clerk user id
        jwt.encode({"sub": USER, "exp": int(time.time()) + 60}, "x" * 32, algorithm="HS256"),  # wrong algorithm
        "not-a-jwt",
    ]
    for tok in bad:
        with pytest.raises(auth.InvalidToken):
            _verify(tok)


def test_verify_through_the_jwks_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without CLERK_JWT_KEY the key comes from the instance's JWKS (the client is replaced; no network)."""
    seen: list[str] = []

    class FakeJwks:
        def get_signing_key_from_jwt(self, tok: str) -> Any:
            seen.append(jwt.get_unverified_header(tok)["kid"])
            return jwt.PyJWK.from_dict(
                {**jwt.algorithms.RSAAlgorithm.to_jwk(SIGNING_KEY.public_key(), as_dict=True), "kid": "ins_test"}
            )

    monkeypatch.setattr(auth, "_jwks_client", lambda url: FakeJwks())
    cfg = auth.ClerkConfig(frontend_api=HOST, jwt_key=None, authorized_parties=None)
    assert run_async(auth.verify_token(token(), cfg, (ORIGIN,))) == USER and seen == ["ins_test"]
    with pytest.raises(auth.InvalidToken):
        run_async(auth.verify_token(token(key=OTHER_KEY), cfg, (ORIGIN,)))


# ------------------------------------------------------------------------------------------------------- HTTP


def test_no_key_configured_stays_anonymous(client: TestClient) -> None:
    assert client.get("/api/health").json()["auth"] == "anonymous"
    r = client.get("/api/sessions", headers=bearer(token()))  # a token means nothing without Clerk configured
    assert r.status_code == 200 and r.headers["set-cookie"].startswith("at_owner=o-")
    assert start(client).status_code == 201


def test_signed_out_requests_get_401(clerk: None, client: TestClient) -> None:
    assert client.get("/api/health").json()["auth"] == "clerk"
    run_msg = {"error": "Sign in to start a run.", "code": "auth_required"}
    sessions_msg = {"error": "Sign in to see your sessions.", "code": "auth_required"}
    for r, want in (
        (start(client), run_msg),
        (client.post("/api/preview", json={"url": "https://data.example/a.csv"}), run_msg),
        (client.get("/api/sessions"), sessions_msg),
        (client.get("/api/sessions/s-abcdefabcdef"), sessions_msg),
        (client.patch("/api/sessions/s-abcdefabcdef", json={"title": "x"}), sessions_msg),
        (client.post("/api/sessions/s-abcdefabcdef/messages", json={"text": "hi"}), sessions_msg),
        (client.get("/api/runs/r-abcdefabcd"), sessions_msg),
        (client.get("/api/runs/r-abcdefabcd/stream"), sessions_msg),
        (client.post("/api/runs/r-abcdefabcd/cancel"), sessions_msg),
    ):
        assert r.status_code == 401 and r.json() == want, r.text
        assert "set-cookie" not in r.headers  # no anonymous identity in clerk mode
    for bad in (token(exp_in=-30), token(key=OTHER_KEY), token(azp="https://evil.example")):
        assert client.get("/api/sessions", headers=bearer(bad)).status_code == 401
    # The engine's ingest keeps its own token auth.
    assert client.post("/api/runs/r-abcdefabcd/ingest", json={"kind": "heartbeat"}).json() == {
        "error": "Bad ingest token."
    }


def test_signed_in_owner_is_the_clerk_user(clerk: None, client: TestClient, other: TestClient) -> None:
    r = start(client, bearer(token()))
    assert r.status_code == 201, r.text
    sid, run_id = r.json()["sessionId"], r.json()["id"]
    assert "set-cookie" not in r.headers

    async def owner_of_session() -> Any:
        async with db.connection() as conn:
            cur = await conn.execute("select owner_id from sessions where id = %s", (sid,))
            return (await cur.fetchone() or {}).get("owner_id")

    assert run_async(owner_of_session()) == USER
    # The same user on another device (the __session cookie this time) sees it; another user doesn't.
    other.cookies.set("__session", token())
    assert [s["id"] for s in other.get("/api/sessions").json()["sessions"]] == [sid]
    assert other.get(f"/api/runs/{run_id}").status_code == 200
    stranger = bearer(token("user_someoneelse"))
    assert client.get("/api/sessions", headers=stranger).json() == {"sessions": []}
    assert client.get(f"/api/runs/{run_id}", headers=stranger).status_code == 404


def test_azp_defaults_to_the_origin_the_browser_called(clerk: None, client: TestClient) -> None:
    preview_origin = "https://autotinker-git-branch.vercel.app"
    tok = token(azp=preview_origin)
    assert client.get("/api/sessions", headers=bearer(tok)).status_code == 401
    fwd = {"x-forwarded-host": "autotinker-git-branch.vercel.app", "x-forwarded-proto": "https"}
    assert client.get("/api/sessions", headers={**bearer(tok), **fwd}).status_code == 200


def test_run_rate_limit_keys_on_the_clerk_user(
    clerk: None, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOTINKER_RUNS_PER_IP_PER_HOUR", "100")
    monkeypatch.setenv("AUTOTINKER_RUNS_PER_OWNER_PER_HOUR", "1")
    assert start(client, bearer(token())).status_code == 201
    assert start(client, bearer(token())).status_code == 429
    assert start(client, bearer(token("user_second"))).status_code == 201


def test_preview_works_when_signed_in(clerk: None, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_preview(url: str) -> dict[str, Any]:
        return {"columns": [], "url": url}

    async def fake_suggest(p: Any, goal: str, **kw: Any) -> tuple[dict[str, Any], bool]:
        return {}, False

    import autotinker_api.routes.preview as route

    monkeypatch.setattr(route, "cached_preview", fake_preview)
    monkeypatch.setattr(route, "suggest_for", fake_suggest)
    r = client.post("/api/preview", json={"url": "https://data.example/a.csv"}, headers=bearer(token()))
    assert r.status_code == 200, r.text


def test_signing_in_claims_the_anonymous_sessions(
    client: TestClient, other: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Used anonymously first (no Clerk yet), in two browsers.
    first = start(client)
    assert first.status_code == 201
    sid = first.json()["sessionId"]
    anon_cookie = client.cookies.get("at_owner")
    assert anon_cookie and start(other).status_code == 201

    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", PK)
    monkeypatch.setenv("CLERK_JWT_KEY", PUBLIC_PEM)
    r = client.get("/api/sessions", headers=bearer(token()))
    assert [s["id"] for s in r.json()["sessions"]] == [sid]  # only this browser's session
    assert 'at_owner=""' in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]
    assert client.get(f"/api/sessions/{sid}", headers=bearer(token())).status_code == 200
    assert client.get(f"/api/runs/{first.json()['id']}", headers=bearer(token())).status_code == 200

    async def owners() -> list[str]:
        async with db.connection() as conn:
            cur = await conn.execute("select id from owners order by id")
            return [row["id"] for row in await cur.fetchall()]

    anon_owner = anon_cookie.split(".")[0]
    assert anon_owner not in run_async(owners()) and USER in run_async(owners())

    # Replaying the old cookie with another account claims nothing (it was spent).
    client.cookies.set("at_owner", anon_cookie)
    assert client.get("/api/sessions", headers=bearer(token("user_other"))).json() == {"sessions": []}
    assert [s["id"] for s in client.get("/api/sessions", headers=bearer(token())).json()["sessions"]] == [sid]
