"""Router tests over httpx.MockTransport (no network)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from autotinker.agent.llm import LLMAuthError, LLMError, is_fatal_llm_error
from autotinker.agent.providers import available_providers, disabled_providers, would_be_cost
from autotinker.agent.router import (
    Bucket,
    ChatRequest,
    Router,
    estimate_request_tokens,
    parse_duration,
)

# These tests exercise the Qwen path explicitly; production routes `reason` to gpt-oss on Groq.
ENV = {
    "GROQ_API_KEY": "gk-secret",
    "GEMINI_API_KEY": "gm-secret",
    "CEREBRAS_API_KEY": "cb-secret",
    "AUTOTINKER_REASON_MODEL": "qwen",
}


def ok_body(content: str = "hi", **msg: Any) -> dict[str, Any]:
    return {
        "choices": [{"message": {"content": content, **msg}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": 50,
            "completion_tokens": 10,
            "prompt_tokens_details": {"cached_tokens": 20},
        },
    }


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


def make(
    handler: Callable[[httpx.Request], httpx.Response], env: dict[str, str] | None = None, **kw: Any
) -> tuple[Router, Clock, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def h(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    clock = Clock()
    r = Router(
        env=env if env is not None else {**ENV, "AUTOTINKER_DISABLED_PROVIDERS": ""},
        transport=httpx.MockTransport(h),
        sleep=clock.sleep,
        clock=clock,
        **kw,
    )
    return r, clock, seen


def host(req: httpx.Request) -> str:
    return req.url.host


def body(req: httpx.Request) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(req.content)
    return out


def req(alias: str = "code", **kw: Any) -> ChatRequest:
    return ChatRequest(alias=alias, system="sys", messages=[{"role": "user", "content": "hello"}], **kw)


# ---------------------------------------------------------------- helpers


def test_parse_duration() -> None:
    assert parse_duration("1m26.4s") == pytest.approx(86.4)
    assert parse_duration("4.065s") == pytest.approx(4.065)
    assert parse_duration("120ms") == pytest.approx(0.12)
    assert parse_duration("7") == 7.0
    assert parse_duration("2h1s") == 7201.0
    assert parse_duration("") is None and parse_duration(None) is None and parse_duration("soon") is None


def test_estimate_and_cost() -> None:
    n = estimate_request_tokens("x" * 350, [{"role": "user", "content": "y" * 700}], None)
    assert 290 <= n <= 330
    from autotinker.agent.providers import GROQ

    spec = GROQ.models["code"]
    assert would_be_cost(spec, 1_000_000, 0) == pytest.approx(0.15)
    assert would_be_cost(spec, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(0.075 + 0.60)


def test_disabled_providers_default_and_env() -> None:
    assert disabled_providers({}) == {"cerebras"}
    assert disabled_providers({"AUTOTINKER_DISABLED_PROVIDERS": "gemini, Cerebras"}) == {"gemini", "cerebras"}
    names = [p.name for p in available_providers(env=ENV)]
    assert names == ["groq", "gemini"]  # cerebras disabled by default
    names = [
        p.name for p in available_providers(env={"GEMINI_API_KEY": "x", "AUTOTINKER_DISABLED_PROVIDERS": ""})
    ]
    assert names == ["gemini"]  # no key -> not available


def test_disabled_provider_is_never_called() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if "groq" in host(r):
            return httpx.Response(500, text="down")
        return httpx.Response(200, json=ok_body())

    router, _, seen = make(handler, env=ENV)  # default: cerebras disabled
    with pytest.raises(LLMError):
        router.chat(req("code"))
    assert seen and all("cerebras" not in host(r) for r in seen)


def test_bucket_refill_and_headers() -> None:
    b = Bucket(tpm=8000, rpm=None, rpd=None)
    b.updated = 0.0
    assert b.wait_for(7000, 0.0) == 0.0
    b.consume(7000, 0.0)
    assert b.wait_for(7000, 0.0) == pytest.approx(6000 * 60 / 8000)
    assert b.wait_for(9000, 0.0) == float("inf")  # never fits the window
    b.update_from_headers(httpx.Headers({"x-ratelimit-remaining-tokens": "7458"}), 10.0)
    assert b.tokens == 7458
    b.update_from_headers(
        httpx.Headers({"x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1m"}), 10.0
    )
    assert b.blocked_until == pytest.approx(70.0)


# ---------------------------------------------------------------- routing


def test_success_records_usage_and_never_leaks_keys() -> None:
    router, _, seen = make(lambda r: httpx.Response(200, json=ok_body("ok", reasoning="because")))
    res = router.chat(req("code", role="coder", max_tokens=1000))
    assert res.text == "ok" and res.reasoning == "because"
    assert res.provider == "groq" and res.model == "openai/gpt-oss-120b"
    u = res.usage
    assert (u.tokens_in, u.tokens_out, u.tokens_cached) == (50, 10, 20)
    assert u.cost_usd == 0.0 and u.would_be_cost_usd > 0
    b = body(seen[0])
    assert b["max_tokens"] == 1000 and b["reasoning_effort"] == "low"
    assert seen[0].headers["authorization"] == "Bearer gk-secret"
    assert "secret" not in repr(router) and "secret" not in json.dumps(router.usage_summary())
    stats = router.usage_summary()["by_model"]["groq/openai/gpt-oss-120b"]
    assert stats["calls"] == 1 and stats["roles"] == {"coder": 1}


def test_qwen_gets_parsed_reasoning_and_cerebras_uses_max_completion_tokens() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if "groq" in host(r):
            return httpx.Response(402, json={"error": "pay"})
        return httpx.Response(200, json=ok_body())

    router, _, seen = make(handler)
    res = router.chat(req("reason", max_tokens=800))
    assert res.provider == "cerebras"
    assert body(seen[0])["reasoning_format"] == "parsed" and body(seen[0])["model"] == "qwen/qwen3.8-27b"
    assert "max_completion_tokens" in body(seen[1]) and body(seen[1])["model"] == "qwen-3.8-27b"
    assert router.down == {"groq": "HTTP 402"}
    assert any("groq" in f for f in res.usage.fallbacks)


def test_402_marks_provider_down_for_the_day() -> None:
    calls: dict[str, int] = {"cerebras": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        if "cerebras" in host(r):
            calls["cerebras"] += 1
            return httpx.Response(402, json={"code": "payment_required"})
        return httpx.Response(429, headers={"retry-after": "1"}, json={})

    env = {"CEREBRAS_API_KEY": "x", "AUTOTINKER_DISABLED_PROVIDERS": ""}
    router, _, _ = make(handler, env=env)
    with pytest.raises(LLMAuthError) as ei:
        router.chat(req("code"))
    assert is_fatal_llm_error(ei.value)
    with pytest.raises(LLMAuthError):
        router.chat(req("code"))
    assert calls["cerebras"] == 1  # never retried once down


def test_429_waits_retry_after_then_succeeds() -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        if n["i"] == 1:
            return httpx.Response(429, headers={"retry-after": "3"}, json={"error": "slow down"})
        return httpx.Response(200, json=ok_body())

    router, clock, _ = make(handler, env={"GROQ_API_KEY": "k"})
    res = router.chat(req("code"))
    assert res.text == "hi" and clock.slept and clock.slept[0] == pytest.approx(3.0, abs=0.01)


def test_gemini_retry_info_and_per_day_quota() -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        if n["i"] == 1:
            return httpx.Response(
                429,
                json=[{"error": {"code": 429, "details": [{"@type": "x.RetryInfo", "retryDelay": "12s"}]}}],
            )
        return httpx.Response(200, json=ok_body())

    router, clock, seen = make(handler, env={"GEMINI_API_KEY": "k"})
    router.chat(req("fast"))
    assert clock.slept[0] == pytest.approx(12.0, abs=0.01)
    assert "generativelanguage" in host(seen[0]) and "reasoning_effort" not in body(seen[0])

    router2, _, _ = make(
        lambda r: httpx.Response(429, json={"error": {"message": "Quota exceeded: GenerateRequestsPerDay"}}),
        env={"GEMINI_API_KEY": "k"},
    )
    with pytest.raises(LLMAuthError):
        router2.chat(req("fast"))
    assert "gemini" in router2.down


def test_5xx_and_timeout_fail_over() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if "groq" in host(r):
            raise httpx.ReadTimeout("slow", request=r)
        return httpx.Response(200, json=ok_body("from cerebras"))

    router, _, _ = make(handler)
    res = router.chat(req("code"))
    assert res.provider == "cerebras" and "ReadTimeout" in res.usage.fallbacks[0]

    def h500(r: httpx.Request) -> httpx.Response:
        return httpx.Response(503) if "groq" in host(r) else httpx.Response(200, json=ok_body())

    router2, _, _ = make(h500)
    assert router2.chat(req("code")).provider == "cerebras"


def test_413_and_window_fit_fail_over() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        return httpx.Response(413) if "groq" in host(r) else httpx.Response(200, json=ok_body())

    router, _, _ = make(handler)
    assert router.chat(req("code")).provider == "cerebras"
    # a prompt bigger than Groq's 8K TPM window goes straight to a provider whose window fits
    router2, _, seen = make(lambda r: httpx.Response(200, json=ok_body()))
    big = ChatRequest(
        alias="code", system="s", messages=[{"role": "user", "content": "x" * 40000}], max_tokens=2000
    )
    assert router2.chat(big).provider == "cerebras"
    assert all("groq" not in host(r) for r in seen)
    # a request that fits only with a smaller max_tokens is clamped, not rejected
    router3, _, seen3 = make(
        lambda r: httpx.Response(200, json=ok_body()),
        env={"GROQ_API_KEY": "k", "AUTOTINKER_REASON_MODEL": "qwen"},
    )
    mid = ChatRequest(
        alias="code", system="s", messages=[{"role": "user", "content": "x" * 14000}], max_tokens=6000
    )
    router3.chat(mid)
    assert body(seen3[0])["max_tokens"] < 6000


def test_waits_for_token_window_instead_of_failing() -> None:
    router, clock, _ = make(
        lambda r: httpx.Response(200, json=ok_body()),
        env={"GROQ_API_KEY": "k", "AUTOTINKER_REASON_MODEL": "qwen"},
    )
    for _ in range(3):
        router.chat(req("code", max_tokens=3000))
    assert clock.slept, "the third 3K request must wait for the 8K TPM window to refill"


def test_privacy_never_routes_rows_to_gemini() -> None:
    router, _, seen = make(lambda r: httpx.Response(200, json=ok_body()), env={"GEMINI_API_KEY": "k"})
    with pytest.raises(LLMError):
        router.chat(req("fast", privacy=True))
    assert seen == []
    router2, _, seen2 = make(lambda r: httpx.Response(200, json=ok_body()))
    assert router2.chat(req("fast", privacy=True)).provider in ("groq", "cerebras")
    assert all("generativelanguage" not in host(r) for r in seen2)


def test_fast_and_reason_fall_back_to_code() -> None:
    router, _, seen = make(
        lambda r: httpx.Response(200, json=ok_body()),
        env={"GROQ_API_KEY": "k", "AUTOTINKER_REASON_MODEL": "qwen"},
    )
    res = router.chat(req("fast"))
    assert res.provider == "groq" and res.usage.alias == "code"


def test_judge_prefers_another_provider_and_sends_forced_tool() -> None:
    router, _, seen = make(
        lambda r: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [{"function": {"name": "select_choice", "arguments": "{}"}}],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5},
            },
        )
    )
    tool = {"type": "function", "function": {"name": "select_choice", "parameters": {}}}
    choice = {"type": "function", "function": {"name": "select_choice"}}
    res = router.chat(req("judge", tools=[tool], tool_choice=choice, avoid_provider="groq"))
    assert res.provider != "groq" and res.tool_calls
    assert body(seen[0])["tool_choice"] == choice and res.text == ""


def test_no_providers_is_fatal() -> None:
    router, _, _ = make(lambda r: httpx.Response(200, json=ok_body()), env={})
    with pytest.raises(LLMAuthError):
        router.chat(req("code"))


def test_other_4xx_fails_over_with_message() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        return (
            httpx.Response(400, json={"error": "bad tools"})
            if "groq" in host(r)
            else httpx.Response(200, json=ok_body())
        )

    router, _, _ = make(handler)
    res = router.chat(req("code"))
    assert res.provider == "cerebras" and "HTTP 400" in res.usage.fallbacks[0]


def test_prefers_requested_model_over_instant_fallback() -> None:
    """reason (qwen) needing a short refill wait beats falling back to code (gpt-oss) at once."""
    router, clock, seen = make(
        lambda r: httpx.Response(200, json=ok_body()),
        env={"GROQ_API_KEY": "k", "AUTOTINKER_REASON_MODEL": "qwen"},
    )
    router.chat(req("reason", max_tokens=7000))
    router.chat(req("reason", max_tokens=1500))  # qwen bucket short by ~a few seconds; gpt-oss is free
    assert [body(r)["model"] for r in seen] == ["qwen/qwen3.8-27b", "qwen/qwen3.8-27b"]
    assert clock.slept and clock.slept[0] < router.prefer_wait_s


def test_learns_output_token_window_from_request_too_large() -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        if body(r)["max_tokens"] > 3000:
            msg = "Request too large for model `qwen` on output tokens per minute: Limit 3000, Requested 4000"
            return httpx.Response(429, json={"error": {"message": msg}})
        return httpx.Response(200, json=ok_body())

    router, _, seen = make(handler, env={"GROQ_API_KEY": "k", "AUTOTINKER_REASON_MODEL": "qwen"})
    res = router.chat(req("reason", max_tokens=4000))
    assert res.model == "qwen/qwen3.8-27b"
    assert [body(r)["max_tokens"] for r in seen] == [4000, 2984]


def test_reason_defaults_to_gpt_oss_on_groq_and_qwen_is_opt_in() -> None:
    env = {k: v for k, v in ENV.items() if k != "AUTOTINKER_REASON_MODEL"}
    env["AUTOTINKER_DISABLED_PROVIDERS"] = "cerebras"
    router, _, seen = make(lambda r: httpx.Response(200, json=ok_body()), env=env)
    router.chat(req("reason", max_tokens=400))
    sent = body(seen[0])
    assert sent["model"] == "openai/gpt-oss-120b" and sent.get("reasoning_effort") == "medium"
    assert "reasoning_format" not in sent


def test_router_log_redacts_account_ids() -> None:
    msg = "Rate limit reached for model `m` in organization `org_01jnfrnzbgecm9reyzycnkvy8h` service tier"
    router, _, _ = make(lambda r: httpx.Response(200, json=ok_body()))
    router._note(msg)
    assert "org_01jnfrnz" not in router.events[-1] and "<redacted>" in router.events[-1]
