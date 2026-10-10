"""Bring-your-own model (`run --llm` / AUTOTINKER_LLM): spec parsing, keys, routing, privacy, SDK and CLI."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
import pytest
from typer.testing import CliRunner

from autotinker.agent.llm import LLMAuthError, LLMError, OpenAICompatLLM, make_llm
from autotinker.agent.providers import (
    LLMSpecError,
    byo_providers,
    parse_llm_spec,
    resolve_llm_specs,
    rows_allowed,
)
from autotinker.agent.router import ChatRequest, Router
from autotinker.failures import RunError, llm_unavailable

DATA = Path(__file__).resolve().parents[1] / "examples" / "data" / "iris_na_classification.csv"
POOL_KEYS = {"GROQ_API_KEY": "gk-secret", "GEMINI_API_KEY": "gm-secret"}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in ("AUTOTINKER_LLM", "AUTOTINKER_FAST_LLM", "AUTOTINKER_NO_ROWS", "AUTOTINKER_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)


def ok(content: str = "hi", **msg: Any) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": content, **msg}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000},
        },
    )


def make(
    env: dict[str, str],
    handler: Callable[[httpx.Request], httpx.Response] = lambda r: ok(),
    **kw: Any,
) -> tuple[Router, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def h(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    slept: list[float] = []
    router = Router(env=env, transport=httpx.MockTransport(h), sleep=slept.append, **kw)
    return router, seen


def req(alias: str = "code", **kw: Any) -> ChatRequest:
    return ChatRequest(
        alias=alias,
        system="sys",
        messages=[{"role": "user", "content": "hello"}],
        reasoning_effort="low",  # every role asks for low effort; only some models may get it
        **kw,
    )


def body(r: httpx.Request) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(r.content)
    return out


# ---------------------------------------------------------------- spec parsing


@pytest.mark.parametrize(
    ("spec", "provider", "model", "base", "key_env"),
    [
        ("openai:gpt-4o-mini", "openai", "gpt-4o-mini", "https://api.openai.com/v1", "OPENAI_API_KEY"),
        (
            "anthropic:claude-sonnet-5-5",
            "anthropic",
            "claude-sonnet-5-5",
            "https://api.anthropic.com/v1",
            "ANTHROPIC_API_KEY",
        ),
        (
            "groq:openai/gpt-oss-120b",
            "groq",
            "openai/gpt-oss-120b",
            "https://api.groq.com/openai/v1",
            "GROQ_API_KEY",
        ),
        (
            "gemini:gemini-3.5-flash-lite",
            "gemini",
            "gemini-3.5-flash-lite",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "GEMINI_API_KEY",
        ),
        (
            "cerebras:gpt-oss-120b",
            "cerebras",
            "gpt-oss-120b",
            "https://api.cerebras.ai/v1",
            "CEREBRAS_API_KEY",
        ),
        (
            "openrouter:anthropic/claude-sonnet-5-5",
            "openrouter",
            "anthropic/claude-sonnet-5-5",
            "https://openrouter.ai/api/v1",
            "OPENROUTER_API_KEY",
        ),
        (
            "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
            "together",
            "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            "https://api.together.xyz/v1",
            "TOGETHER_API_KEY",
        ),
        (
            "mistral:mistral-large-latest",
            "mistral",
            "mistral-large-latest",
            "https://api.mistral.ai/v1",
            "MISTRAL_API_KEY",
        ),
        (
            "deepseek:deepseek-chat",
            "deepseek",
            "deepseek-chat",
            "https://api.deepseek.com/v1",
            "DEEPSEEK_API_KEY",
        ),
        ("ollama:llama3.1:8b", "ollama", "llama3.1:8b", "http://localhost:11434/v1", ""),
        ("OpenAI:gpt-4o", "openai", "gpt-4o", "https://api.openai.com/v1", "OPENAI_API_KEY"),
        (
            "compat:gemini-3.5-flash-lite@https://generativelanguage.googleapis.com/v1beta/openai/",
            "compat",
            "gemini-3.5-flash-lite",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "AUTOTINKER_LLM_API_KEY",
        ),
        (
            "compat:org/model@2024@http://10.0.0.5:8000/v1",
            "compat",
            "org/model@2024",
            "http://10.0.0.5:8000/v1",
            "AUTOTINKER_LLM_API_KEY",
        ),
    ],
)
def test_parse_every_spec_form(spec: str, provider: str, model: str, base: str, key_env: str) -> None:
    c = parse_llm_spec(spec, env={})
    assert (c.provider, c.model, c.base_url, c.key_env) == (provider, model, base, key_env)
    assert c.max_tokens_param == (
        "max_completion_tokens" if provider in ("openai", "cerebras") else "max_tokens"
    )


def test_ollama_base_url_override() -> None:
    assert (
        parse_llm_spec("ollama:qwen3", {"OLLAMA_BASE_URL": "http://gpu:11434/"}).base_url
        == "http://gpu:11434/v1"
    )
    assert (
        parse_llm_spec("ollama:qwen3", {"OLLAMA_BASE_URL": "http://gpu:9/v1"}).base_url == "http://gpu:9/v1"
    )


@pytest.mark.parametrize(
    ("spec", "needle"),
    [
        ("gpt-4o-mini", "provider:model"),
        ("openai:", "provider:model"),
        ("nope:some-model", "Unknown model provider"),
        ("compat:llama3", "compat:<model>@<base_url>"),
        ("compat:llama3@localhost:8000", "compat:<model>@<base_url>"),
        ("heuristic", "heuristic"),
    ],
)
def test_bad_specs_say_what_is_wrong(spec: str, needle: str) -> None:
    with pytest.raises(LLMSpecError) as ei:
        parse_llm_spec(spec, env={})
    assert needle in str(ei.value) and ei.value.hint
    if spec == "heuristic":
        assert "--single-shot" in ei.value.hint and "evolve --llm heuristic" in ei.value.hint


def test_missing_key_names_the_variable() -> None:
    with pytest.raises(LLMSpecError, match="OPENAI_API_KEY is not set") as ei:
        byo_providers("openai:gpt-4o-mini", env=POOL_KEYS)
    assert "OPENAI_API_KEY" in ei.value.hint
    with pytest.raises(LLMSpecError, match="GROQ_API_KEY"):  # the fast model's key is checked too
        byo_providers("openai:gpt-4o-mini", "groq:openai/gpt-oss-120b", env={"OPENAI_API_KEY": "k"})
    # keyless: ollama, and compat without AUTOTINKER_LLM_API_KEY
    assert byo_providers("ollama:llama3.1", env={})[0].key_env == ""
    assert byo_providers("compat:m@http://localhost:8000/v1", env={})[0].name == "compat"
    with pytest.raises(LLMSpecError, match="OPENAI_API_KEY"):
        Router(llm="openai:gpt-4o-mini", env={})


def test_resolve_flag_wins_over_env() -> None:
    env = {"AUTOTINKER_LLM": "groq:a", "AUTOTINKER_FAST_LLM": "gemini:b"}
    assert resolve_llm_specs(None, None, env) == ("groq:a", "gemini:b")
    assert resolve_llm_specs("openai:x", None, env) == ("openai:x", "gemini:b")
    assert resolve_llm_specs("openai:x", "openai:y", env) == ("openai:x", "openai:y")
    assert resolve_llm_specs(None, None, {}) == (None, None)
    with pytest.raises(LLMSpecError, match="without a main model"):
        resolve_llm_specs(None, "groq:a", {})


# ---------------------------------------------------------------- routing


def test_openai_url_bearer_max_completion_tokens_no_effort_and_list_price() -> None:
    router, seen = make({**POOL_KEYS, "OPENAI_API_KEY": "sk-secret"}, llm="openai:gpt-4o-mini")
    res = router.chat(req("code", max_tokens=1000))
    r = seen[0]
    assert str(r.url) == "https://api.openai.com/v1/chat/completions"
    assert r.headers["authorization"] == "Bearer sk-secret"
    b = body(r)
    assert b["model"] == "gpt-4o-mini" and b["max_completion_tokens"] == 1000 and "max_tokens" not in b
    assert "reasoning_effort" not in b  # gpt-4o-mini is not a reasoning model
    assert (res.provider, res.model) == ("openai", "gpt-4o-mini")
    assert res.usage.cost_usd == pytest.approx(0.15 + 0.60)  # paid provider: list price is the actual cost
    stats = router.usage_summary()
    assert (
        list(stats["by_model"]) == ["openai/gpt-4o-mini"]
        and stats["by_model"]["openai/gpt-4o-mini"]["price_known"]
    )
    assert stats["llm"] == {"llm": "openai:gpt-4o-mini", "fast_llm": "openai:gpt-4o-mini"}
    assert "sk-secret" not in json.dumps(stats) and "sk-secret" not in repr(router)


@pytest.mark.parametrize("model", ["gpt-5-mini", "o3-mini", "o4-mini"])
def test_openai_reasoning_models_get_reasoning_effort(model: str) -> None:
    router, seen = make({"OPENAI_API_KEY": "k"}, llm=f"openai:{model}")
    router.chat(req())
    assert body(seen[0])["reasoning_effort"] == "low"


def test_anthropic_goes_to_its_openai_compatible_endpoint() -> None:
    router, seen = make({"ANTHROPIC_API_KEY": "ak"}, llm="anthropic:claude-sonnet-5-5")
    router.chat(req())
    assert str(seen[0].url) == "https://api.anthropic.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer ak"
    b = body(seen[0])
    assert "reasoning_effort" not in b and b["max_tokens"] == 2048
    assert router.chat(req()).usage.cost_usd > 0  # priced from llm.PRICES


def test_keyless_endpoints_send_no_authorization() -> None:
    router, seen = make({}, llm="ollama:llama3.1")
    router.chat(req())
    assert str(seen[0].url) == "http://localhost:11434/v1/chat/completions"
    assert "authorization" not in seen[0].headers
    router, seen = make({}, llm="compat:my-model@http://box:8000/v1")
    router.chat(req())
    assert (
        str(seen[0].url) == "http://box:8000/v1/chat/completions" and "authorization" not in seen[0].headers
    )
    router, seen = make({"AUTOTINKER_LLM_API_KEY": "ck"}, llm="compat:my-model@http://box:8000/v1")
    res = router.chat(req())
    assert seen[0].headers["authorization"] == "Bearer ck"
    assert (res.provider, res.model) == ("compat", "my-model")


def test_unknown_model_has_no_effort_no_buckets_and_unknown_price() -> None:
    def h(r: httpx.Request) -> httpx.Response:
        resp = ok()
        resp.headers["x-ratelimit-limit-tokens"] = "100"  # not used for an unknown provider
        resp.headers["x-ratelimit-remaining-tokens"] = "0"
        return resp

    router, seen = make({"TOGETHER_API_KEY": "t"}, h, llm="together:some/new-model")
    for _ in range(3):
        res = router.chat(req(max_tokens=4000))
    assert len(seen) == 3 and "reasoning_effort" not in body(seen[0]) and body(seen[0])["max_tokens"] == 4000
    b = router.buckets["together/some/new-model"]
    assert b.tpm is None and b.rpm is None
    assert res.usage.cost_usd == 0.0 and res.usage.would_be_cost_usd == 0.0
    s = router.usage_summary()
    assert s["by_model"]["together/some/new-model"]["price_known"] is False
    assert any("no list price known for together/some/new-model" in e for e in s["log"])


def test_byo_overrides_the_free_pool_for_every_alias() -> None:
    env = {**POOL_KEYS, "OPENAI_API_KEY": "k", "AUTOTINKER_LLM": "openai:gpt-4o-mini"}
    router, seen = make(env)
    assert router.provider_names == ["openai"]
    for alias in ("code", "reason", "fast", "judge"):
        router.chat(req(alias, avoid_provider="openai" if alias == "judge" else None))
    assert {r.url.host for r in seen} == {"api.openai.com"}
    assert set(router.usage_summary()["by_model"]) == {"openai/gpt-4o-mini"}


def test_fast_llm_serves_fast_and_judge_crosses_over() -> None:
    env = {**POOL_KEYS, "OPENAI_API_KEY": "k"}
    router, seen = make(env, llm="openai:gpt-4o-mini", fast_llm="groq:openai/gpt-oss-120b")
    assert router.provider_names == ["openai", "groq"]
    assert router.chat(req("fast")).provider == "groq"
    assert router.chat(req("code")).provider == "openai"
    assert router.chat(req("reason")).provider == "openai"
    assert router.chat(req("judge", avoid_provider="openai")).provider == "groq"
    assert set(router.usage_summary()["by_model"]) == {"openai/gpt-4o-mini", "groq/openai/gpt-oss-120b"}
    assert {r.url.host for r in seen} == {"api.openai.com", "api.groq.com"}


def test_fast_falls_back_to_the_main_model() -> None:
    def h(r: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"}) if r.url.host == "api.groq.com" else ok()

    router, _ = make(
        {**POOL_KEYS, "OPENAI_API_KEY": "k"}, h, llm="openai:gpt-4o-mini", fast_llm="groq:llama-x"
    )
    assert router.chat(req("fast")).provider == "openai" and router.down == {"groq": "HTTP 401"}


def test_known_pool_model_keeps_limits_effort_and_free_tier() -> None:
    env = {**POOL_KEYS, "AUTOTINKER_DISABLED_PROVIDERS": "groq,gemini"}  # your choice beats the pool's switch
    router, seen = make(env, llm="groq:openai/gpt-oss-120b")
    res = router.chat(req("reason"))
    assert body(seen[0])["reasoning_effort"] == "low" and seen[0].url.host == "api.groq.com"
    assert router.buckets["groq/openai/gpt-oss-120b"].rpm == 30  # Groq's free-tier limits kept
    assert res.usage.cost_usd == 0.0 and res.usage.would_be_cost_usd > 0
    # gemini: limits kept, never reasoning_effort
    router, seen = make(POOL_KEYS, llm="gemini:gemini-3.5-flash-lite")
    router.chat(req("code"))
    assert (
        "reasoning_effort" not in body(seen[0]) and router.buckets["gemini/gemini-3.5-flash-lite"].rpm == 15
    )
    # an unknown Groq model: no reasoning_effort (only gpt-oss gets it)
    router, seen = make(POOL_KEYS, llm="groq:llama-3.3-70b-versatile")
    router.chat(req("code"))
    assert "reasoning_effort" not in body(seen[0])


def test_429_is_retried_with_backoff() -> None:
    calls = {"n": 0}

    def h(r: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "3"}, json={"error": "rate limited"})
        return ok()

    seen: list[httpx.Request] = []
    slept: list[float] = []
    router = Router(
        llm="openai:gpt-4o-mini",
        env={"OPENAI_API_KEY": "k"},
        transport=httpx.MockTransport(lambda r: (seen.append(r), h(r))[1]),
        sleep=slept.append,
    )
    res = router.chat(req())
    assert res.provider == "openai" and calls["n"] == 2 and slept and slept[0] > 0
    assert "429" in res.usage.fallbacks[0]


def test_insufficient_quota_and_bad_key_are_fatal() -> None:
    def h(r: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"code": "insufficient_quota", "message": "no credit"}})

    router, seen = make({"OPENAI_API_KEY": "k"}, h, llm="openai:gpt-4o-mini")
    with pytest.raises(LLMAuthError, match="insufficient_quota"):
        router.chat(req())
    assert len(seen) == 1

    router, _ = make(
        {"OPENAI_API_KEY": "k"}, lambda r: httpx.Response(401, json={}), llm="openai:gpt-4o-mini"
    )
    with pytest.raises(LLMAuthError) as ei:
        router.chat(req())
    assert "refused the API key" in llm_unavailable(str(ei.value)).hint


# ---------------------------------------------------------------- privacy


def test_byo_may_receive_rows_but_no_rows_flag_blocks_every_provider() -> None:
    router, seen = make(POOL_KEYS, llm="gemini:gemini-3.5-flash-lite")
    assert router.chat(req("code", privacy=True)).provider == "gemini"  # your choice: rows allowed
    assert router.send_rows
    router, seen = make({**POOL_KEYS, "AUTOTINKER_NO_ROWS": "1"}, llm="gemini:gemini-3.5-flash-lite")
    assert not router.send_rows
    with pytest.raises(LLMError, match="AUTOTINKER_NO_ROWS"):
        router.chat(req("code", privacy=True))
    assert seen == []
    router, seen = make({**POOL_KEYS, "AUTOTINKER_NO_ROWS": "true"})  # free pool too
    with pytest.raises(LLMError, match="AUTOTINKER_NO_ROWS"):
        router.chat(req("code", privacy=True))
    assert seen == [] and router.chat(req("code")).provider == "groq"
    assert rows_allowed({}) and not rows_allowed({"AUTOTINKER_NO_ROWS": "yes"})


def test_no_rows_makes_intake_schema_only(tmp_path: Path) -> None:
    from autotinker.evolve.agentic import run_intake

    sentinel = "SENTINEL_CELL_VALUE"
    df = pd.DataFrame({"x": range(40), "note": [sentinel] * 40, "churn": ["yes", "no"] * 20})
    reply = {"target": "churn", "problem_type": "binary", "metric": "roc_auc", "goal": "g", "plain": "ok"}

    def h(r: httpx.Request) -> httpx.Response:
        return ok(json.dumps(reply))

    for no_rows, rows_sent in (("", True), ("1", False)):
        router, seen = make(
            {"OPENAI_API_KEY": "k", "AUTOTINKER_NO_ROWS": no_rows}, h, llm="openai:gpt-4o-mini"
        )
        d = run_intake(router, df, goal="predict churn")
        assert d.target == "churn" and len(seen) == 1  # schema-only at once: no failed "rows" attempt
        assert (sentinel in seen[0].content.decode()) is rows_sent


# ---------------------------------------------------------------- SDK + CLI


def test_sdk_passes_llm_through_to_the_router(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import autotinker.agent.router as router_mod
    from autotinker.api import agentic_run

    got: dict[str, Any] = {}

    class Stop(Exception):
        pass

    def fake_router(**kw: Any) -> Any:
        got.update(kw)
        raise Stop

    monkeypatch.setattr(router_mod, "Router", fake_router)
    with pytest.raises(Stop):
        agentic_run(
            str(DATA), target="variety", workdir=tmp_path, llm="openai:gpt-4o-mini", fast_llm="groq:x"
        )
    assert got == {"llm": "openai:gpt-4o-mini", "fast_llm": "groq:x"}
    with pytest.raises(ValueError, match="either `backend` or `llm`"):
        agentic_run(str(DATA), target="variety", workdir=tmp_path, backend=object(), llm="openai:gpt-4o-mini")


def test_sdk_missing_key_is_a_run_error_before_any_agent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from autotinker.api import agentic_run

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RunError) as ei:
        agentic_run(str(DATA), target="variety", workdir=tmp_path, llm="openai:gpt-4o-mini")
    f = ei.value.failure
    assert f.code == "llm_unavailable" and "OPENAI_API_KEY" in f.message and "OPENAI_API_KEY" in f.hint
    monkeypatch.setenv("AUTOTINKER_LLM", "mistral:mistral-small-latest")  # the env var works for the SDK too
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    with pytest.raises(RunError, match="MISTRAL_API_KEY"):
        agentic_run(str(DATA), target="variety", workdir=tmp_path)


def test_make_llm_shares_the_endpoint_table(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("TOGETHER_API_KEY", "t")
    o, t = make_llm("openai:gpt-4o-mini"), make_llm("together:x")
    assert isinstance(o, OpenAICompatLLM) and isinstance(t, OpenAICompatLLM)
    assert o.max_tokens_param == "max_completion_tokens" and t.base_url == "https://api.together.xyz/v1"


runner = CliRunner()


def test_cli_llm_heuristic_points_to_single_shot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    res = runner.invoke(app_(), ["run", str(DATA), "--target", "variety", "--llm", "heuristic"])
    assert res.exit_code == 2 and "--single-shot" in res.output and "no tool calling" in res.output
    res = runner.invoke(app_(), ["run", str(DATA), "--target", "variety", "--cheap-llm", "x"])
    assert res.exit_code == 2 and "--single-shot" in res.output


def test_cli_missing_key_ends_with_run_failed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from autotinker.obs.events import parse_event

    monkeypatch.chdir(tmp_path)  # no .env here
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    args = ["run", str(DATA), "--target", "variety", "--llm", "openai:gpt-4o-mini", "--events-stdout"]
    res = runner.invoke(app_(), [*args, "--out", str(tmp_path)])
    assert res.exit_code == 2
    ev = parse_event(res.stdout.strip().splitlines()[-1])
    assert ev.type == "run_failed" and ev.code == "llm_unavailable" and "OPENAI_API_KEY" in ev.message


@pytest.mark.timeout(600)
def test_cli_single_shot_heuristic_still_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from autotinker.obs.events import parse_event

    monkeypatch.chdir(tmp_path)
    args = ["run", str(DATA), "--target", "variety", "--single-shot", "--llm", "heuristic", "--events-stdout"]
    res = runner.invoke(app_(), [*args, "--out", str(tmp_path)])
    assert res.exit_code == 0, res.output
    events = [parse_event(ln) for ln in res.stdout.splitlines() if ln.strip()]
    assert events[0].type == "run_started" and events[0].proposer == "heuristic"
    assert events[-1].type == "run_finished"


def app_() -> Any:
    from autotinker.cli import app

    return app
