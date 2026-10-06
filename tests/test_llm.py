from __future__ import annotations

import json

import httpx
import pytest

from autotinker.agent import prompts
from autotinker.agent.context import ProposalContext
from autotinker.agent.llm import (
    AnthropicLLM,
    LLMError,
    OpenAICompatLLM,
    ScriptedLLM,
    cost_usd,
    make_llm,
    price_for,
)
from autotinker.agent.proposer import LLMProposer, ProposalFailed
from autotinker.contracts import IdeaCategory
from tests.conftest import make_profile

CODE = "def build_pipeline(profile):\n    return None  # long enough code"
GOOD = json.dumps(
    {
        "title": "Lower learning rate",
        "rationale": "less overfit",
        "category": "hyperparameters",
        "radical": False,
        "code": CODE,
    }
)


def test_parse_plain_and_fenced() -> None:
    assert prompts.parse_structured(GOOD, prompts.ProposalOut).title == "Lower learning rate"
    fenced = f"Here you go:\n```json\n{GOOD}\n```\nthanks"
    out = prompts.parse_structured(fenced, prompts.ProposalOut)
    assert out.category == IdeaCategory.hyperparameters and out.code == CODE


def test_parse_code_from_python_fence_and_category_normalisation() -> None:
    text = (
        '{"title": "Add ratio features", "category": "Feature Engineering", "radical": false}\n'
        f"```python\n{CODE}\n```"
    )
    out = prompts.parse_structured(text, prompts.ProposalOut)
    assert out.category == IdeaCategory.feature_engineering and "build_pipeline" in out.code


def test_parse_rejects_garbage() -> None:
    with pytest.raises(prompts.ParseError):
        prompts.parse_structured("no json here", prompts.ProposalOut)


def ctx() -> ProposalContext:
    return ProposalContext(
        profile=make_profile(),
        contract_doc="CONTRACT",
        allowed_imports=frozenset({"sklearn"}),
        best_code="# best",
        ledger_summary="- e000 KEEP baseline",
    )


def test_proposer_retries_once_on_parse_failure() -> None:
    llm = ScriptedLLM(["sorry, not json", GOOD])
    prop = LLMProposer(llm).propose_and_implement(ctx())
    assert prop.idea.title == "Lower learning rate" and len(prop.usages) == 2
    retry = llm.calls[1]["messages"]
    assert retry[-2]["role"] == "assistant" and retry[-1]["role"] == "user"
    assert "could not be parsed" in retry[-1]["content"]


def test_proposer_gives_up_after_one_retry() -> None:
    llm = ScriptedLLM(["nope", "still nope", GOOD])
    with pytest.raises(ProposalFailed) as ei:
        LLMProposer(llm).propose_and_implement(ctx())
    assert len(ei.value.usages) == 2 and len(llm.queue) == 1


def test_prompt_contains_only_allowed_context() -> None:
    llm = ScriptedLLM([GOOD])
    LLMProposer(llm).propose_and_implement(ctx())
    call = llm.calls[0]
    assert "CONTRACT" in call["system"] and "sklearn" in call["system"]
    user = call["messages"][0]["content"]
    assert '"n_rows": 150' in user and "e000 KEEP baseline" in user and "# best" in user


def test_cheap_model_implements_and_repairs() -> None:
    strong = ScriptedLLM(
        [json.dumps({"title": "Try ExtraTrees", "category": "model_family", "radical": True})]
    )
    cheap = ScriptedLLM([json.dumps({"code": CODE}), json.dumps({"code": CODE + "\n# fixed"})], model="cheap")
    p = LLMProposer(strong, cheap)
    prop = p.propose_and_implement(ctx())
    assert prop.idea.radical and [u.purpose for u in prop.usages] == ["propose", "implement"]
    rep = p.repair(ctx(), CODE, "ValueError: boom")
    assert rep.code.endswith("# fixed") and rep.usages[0].model == "cheap"
    assert "ValueError: boom" in cheap.calls[1]["messages"][0]["content"]


def _anthropic_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-5-5",
            "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": GOOD}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 0},
        },
    )


def test_anthropic_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return _anthropic_ok(req)

    llm = AnthropicLLM(
        "claude-sonnet-5-5", api_key="sk-test", client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    resp = llm.complete("SYS", [{"role": "user", "content": "hi"}], max_tokens=1234, purpose="propose")
    req = seen[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == "sk-test" and req.headers["anthropic-version"] == "2023-06-01"
    body = json.loads(req.content)
    assert body["model"] == "claude-sonnet-5-5" and body["max_tokens"] == 1234 and body["system"] == "SYS"
    assert body["messages"] == [{"role": "user", "content": "hi"}]
    assert "temperature" not in body and "thinking" not in body
    assert (
        body["fallbacks"] == "default" and req.headers["anthropic-beta"] == "server-side-fallback-2026-07-01"
    )
    assert resp.text == GOOD
    assert resp.usage.input_tokens == 1000 and resp.usage.output_tokens == 500
    assert resp.usage.cost_usd == pytest.approx((1000 * 2 + 500 * 10) / 1e6)


def test_anthropic_retries_on_429_and_5xx_then_fails_on_400() -> None:
    codes = iter([429, 529, 200])

    def handler(req: httpx.Request) -> httpx.Response:
        c = next(codes)
        return _anthropic_ok(req) if c == 200 else httpx.Response(c, headers={"retry-after": "0"}, json={})

    sleeps: list[float] = []
    llm = AnthropicLLM(
        "claude-haiku-4-5",
        api_key="k",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=sleeps.append,
    )
    assert llm.complete("s", [{"role": "user", "content": "x"}], max_tokens=10, purpose="repair").text == GOOD
    assert len(sleeps) == 2
    assert "fallbacks" not in llm.build_request("s", [], 10)[1]  # haiku: no server-side fallback

    bad = AnthropicLLM(
        "claude-sonnet-5-5",
        api_key="k",
        sleep=sleeps.append,
        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(400, json={}))),
    )
    with pytest.raises(LLMError, match="HTTP 400"):
        bad.complete("s", [], max_tokens=10, purpose="propose")


def test_anthropic_refusal_raises() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "content": [],
                "stop_reason": "refusal",
                "stop_details": {"category": "cyber"},
                "usage": {},
            },
        )

    llm = AnthropicLLM(api_key="k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(LLMError, match="refused"):
        llm.complete("s", [], max_tokens=10, purpose="propose")


def test_openai_compat_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "hey"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    llm = OpenAICompatLLM(
        "llama-x",
        base_url="https://api.groq.com/openai/v1",
        api_key="g",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    r = llm.complete("SYS", [{"role": "user", "content": "q"}], max_tokens=50, purpose="draft")
    body = json.loads(seen[0].content)
    assert str(seen[0].url).endswith("/chat/completions") and seen[0].headers["authorization"] == "Bearer g"
    assert body["messages"][0] == {"role": "system", "content": "SYS"} and r.text == "hey"
    assert r.usage.input_tokens == 10


def test_prices_and_factory(monkeypatch: pytest.MonkeyPatch) -> None:
    assert price_for("claude-haiku-4-5-20251001") == (1.0, 5.0)
    assert price_for("claude-sonnet-5-5") == (2.0, 10.0)
    assert cost_usd("unknown-model", 1000, 1000) == 0.0
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("GROQ_API_KEY", "g")
    assert make_llm("anthropic:claude-sonnet-5-5").model == "claude-sonnet-5-5"
    assert isinstance(make_llm("groq:llama-3.3-70b"), OpenAICompatLLM)
    with pytest.raises(ValueError):
        make_llm("nope:x")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    with pytest.raises(LLMError):
        make_llm("anthropic:claude-sonnet-5-5")


def test_truncated_reply_retries_with_more_tokens() -> None:
    class Trunc(ScriptedLLM):
        def complete(self, system, messages, *, max_tokens, purpose):  # type: ignore[no-untyped-def]
            r = super().complete(system, messages, max_tokens=max_tokens, purpose=purpose)
            self.calls[-1]["max_tokens"] = max_tokens
            if len(self.calls) == 1:
                r.stop_reason = "max_tokens"
            return r

    llm = Trunc(['{"title": "cut', GOOD])
    prop = LLMProposer(llm, max_tokens=1000).propose_and_implement(ctx())
    assert prop.idea.title == "Lower learning rate"
    assert [c["max_tokens"] for c in llm.calls] == [1000, 2000]
