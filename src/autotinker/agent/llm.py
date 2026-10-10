"""Provider-agnostic LLM clients (plain httpx, no SDK dependency).

Every call returns an `LLMResponse` with an `LLMUsage` (model, tokens, cost, latency) so the loop can
account for cost per experiment.
"""

from __future__ import annotations

import os
import random
import sys
import time
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

import httpx

from autotinker.agent.providers import ENDPOINTS
from autotinker.contracts import LLMUsage

Purpose = Literal["draft", "propose", "implement", "repair"]

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"
CHEAP_ANTHROPIC_MODEL = "claude-haiku-4-5"

# USD per million tokens (input, output). Matched by prefix so dated snapshots price correctly.
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "gpt-4o-mini": (0.15, 0.6),
    "gpt-4o": (2.5, 10.0),
}

_warned: set[str] = set()


def price_for(model: str) -> tuple[float, float] | None:
    best: tuple[int, tuple[float, float]] | None = None
    for prefix, p in PRICES.items():
        if model.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), p)
    return best[1] if best else None


def cost_usd(
    model: str, input_tokens: int, output_tokens: int, cache_write: int = 0, cache_read: int = 0
) -> float:
    p = price_for(model)
    if p is None:
        if model not in _warned:
            _warned.add(model)
            print(f"[autotinker] no price known for model {model!r}; cost reported as 0", file=sys.stderr)
        return 0.0
    pin, pout = p
    return (
        input_tokens * pin + cache_write * pin * 1.25 + cache_read * pin * 0.1 + output_tokens * pout
    ) / 1e6


class LLMError(RuntimeError):
    pass


class LLMAuthError(LLMError):
    """401/403 from the provider: retrying or re-prompting cannot help, so the run should stop at once."""


def is_fatal_llm_error(exc: BaseException | None) -> bool:
    """True if `exc` or anything in its cause/context chain is an LLMAuthError."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        if isinstance(exc, LLMAuthError):
            return True
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return False


@dataclass
class LLMResponse:
    text: str
    usage: LLMUsage
    stop_reason: str | None = None


class LLM(Protocol):
    model: str

    def complete(
        self, system: str, messages: list[dict[str, Any]], *, max_tokens: int, purpose: Purpose
    ) -> LLMResponse: ...


def _retry_delay(attempt: int, resp: httpx.Response | None, base: float) -> float:
    if resp is not None:
        ra = resp.headers.get("retry-after")
        if ra:
            try:
                return min(float(ra), 60.0)
            except ValueError:
                pass
    return float(min(base * (2**attempt) + random.uniform(0, base), 60.0))


def _post_with_retries(
    client: httpx.Client,
    url: str,
    *,
    headers: dict[str, str],
    json: dict[str, Any],
    max_retries: int,
    backoff_s: float,
    sleep: Callable[[float], None],
) -> httpx.Response:
    last: str = ""
    for attempt in range(max_retries + 1):
        resp: httpx.Response | None = None
        try:
            resp = client.post(url, headers=headers, json=json)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if resp.status_code < 400:
                return resp
            if resp.status_code in (401, 403):
                raise LLMAuthError(
                    f"HTTP {resp.status_code} from {url} (check the API key): {resp.text[:300]}"
                )
            if resp.status_code != 429 and resp.status_code < 500:
                raise LLMError(f"HTTP {resp.status_code} from {url}: {resp.text[:500]}")
            last = f"HTTP {resp.status_code}: {resp.text[:200]}"
        if attempt < max_retries:
            sleep(_retry_delay(attempt, resp, backoff_s))
    raise LLMError(f"giving up after {max_retries + 1} attempts: {last}")


class AnthropicLLM:
    """Claude via the Messages API (POST /v1/messages) over raw HTTP.

    Thinking is left at the model default (adaptive on current models); no sampling params and no
    assistant prefill are sent, since current models reject them. For models that support it, the
    server-side refusal fallback (`fallbacks: "default"`) is enabled.
    """

    API_URL = "https://api.anthropic.com/v1/messages"
    _FALLBACK_MODELS = ("claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1")

    def __init__(
        self,
        model: str = DEFAULT_ANTHROPIC_MODEL,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_s: float = 300.0,
        max_retries: int = 4,
        backoff_s: float = 1.0,
        effort: str | None = None,
        refusal_fallback: bool = True,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.model = model
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if not self.api_key:
            raise LLMError("ANTHROPIC_API_KEY is not set")
        base = base_url or os.environ.get("ANTHROPIC_BASE_URL")
        self.url = base.rstrip("/") + "/v1/messages" if base else self.API_URL
        self.client = client or httpx.Client(timeout=timeout_s)
        self.max_retries = max_retries
        self.backoff_s = backoff_s
        self.effort = effort
        # server-side refusal fallback: first-party API only (a proxy behind base_url may reject the field)
        self.refusal_fallback = refusal_fallback and not base and model.startswith(self._FALLBACK_MODELS)
        self._sleep = sleep

    def build_request(
        self, system: str, messages: list[dict[str, Any]], max_tokens: int
    ) -> tuple[dict[str, str], dict[str, Any]]:
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        body: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }
        if self.effort:
            body["output_config"] = {"effort": self.effort}
        if self.refusal_fallback:
            headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
            body["fallbacks"] = "default"
        return headers, body

    def complete(
        self, system: str, messages: list[dict[str, Any]], *, max_tokens: int, purpose: Purpose
    ) -> LLMResponse:
        headers, body = self.build_request(system, messages, max_tokens)
        t0 = time.perf_counter()
        resp = _post_with_retries(
            self.client,
            self.url,
            headers=headers,
            json=body,
            max_retries=self.max_retries,
            backoff_s=self.backoff_s,
            sleep=self._sleep,
        )
        latency = time.perf_counter() - t0
        data = resp.json()
        stop = data.get("stop_reason")
        if stop == "refusal":
            details = data.get("stop_details") or {}
            raise LLMError(f"model refused the request (category={details.get('category')})")
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        u = data.get("usage") or {}
        served_model = str(data.get("model") or self.model)
        inp, out = int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0)
        cw, cr = int(u.get("cache_creation_input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0)
        usage = LLMUsage(
            purpose=purpose,
            model=served_model,
            input_tokens=inp + cw + cr,
            output_tokens=out,
            cost_usd=cost_usd(served_model, inp, out, cw, cr),
            latency_s=latency,
        )
        return LLMResponse(text=text, usage=usage, stop_reason=stop)


# provider -> (base_url, api key env var, max-tokens field), from the one endpoint table in providers.py.
# Anthropic uses its native Messages API here (AnthropicLLM); keyless endpoints (Ollama) are agentic-only.
_OPENAI_COMPAT: dict[str, tuple[str, str, str]] = {
    name: (ep.base_url, ep.key_env, ep.max_tokens_param)
    for name, ep in ENDPOINTS.items()
    if ep.key_env and name != "anthropic"
}


class OpenAICompatLLM:
    """Any OpenAI-compatible /chat/completions endpoint (OpenAI, Groq, OpenRouter, local servers)."""

    def __init__(
        self,
        model: str,
        *,
        base_url: str,
        api_key_env: str = "OPENAI_API_KEY",
        api_key: str | None = None,
        max_tokens_param: str = "max_tokens",
        timeout_s: float = 300.0,
        max_retries: int = 4,
        backoff_s: float = 1.0,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.model = model
        self.max_tokens_param = max_tokens_param
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get(api_key_env, "")
        if not self.api_key:
            raise LLMError(f"{api_key_env} is not set")
        self.client = client or httpx.Client(timeout=timeout_s)
        self.max_retries = max_retries
        self.backoff_s = backoff_s
        self._sleep = sleep

    def complete(
        self, system: str, messages: list[dict[str, Any]], *, max_tokens: int, purpose: Purpose
    ) -> LLMResponse:
        body = {
            "model": self.model,
            self.max_tokens_param: max_tokens,
            "messages": [{"role": "system", "content": system}, *messages],
        }
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}
        t0 = time.perf_counter()
        resp = _post_with_retries(
            self.client,
            f"{self.base_url}/chat/completions",
            headers=headers,
            json=body,
            max_retries=self.max_retries,
            backoff_s=self.backoff_s,
            sleep=self._sleep,
        )
        latency = time.perf_counter() - t0
        data = resp.json()
        choices = data.get("choices") or [{}]
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        u = data.get("usage") or {}
        inp, out = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
        usage = LLMUsage(
            purpose=purpose,
            model=self.model,
            input_tokens=inp,
            output_tokens=out,
            cost_usd=cost_usd(self.model, inp, out),
            latency_s=latency,
        )
        return LLMResponse(text=text, usage=usage, stop_reason=choices[0].get("finish_reason"))


class ScriptedLLM:
    """Returns queued responses in order (tests). Records every request it receives."""

    def __init__(
        self, responses: Iterable[str], model: str = "scripted", tokens: tuple[int, int] = (100, 50)
    ):
        self.model = model
        self.queue: deque[str] = deque(responses)
        self.calls: list[dict[str, Any]] = []
        self.tokens = tokens

    def complete(
        self, system: str, messages: list[dict[str, Any]], *, max_tokens: int, purpose: Purpose
    ) -> LLMResponse:
        self.calls.append({"system": system, "messages": [dict(m) for m in messages], "purpose": purpose})
        if not self.queue:
            raise LLMError("ScriptedLLM: no responses left")
        text = self.queue.popleft()
        usage = LLMUsage(
            purpose=purpose,
            model=self.model,
            input_tokens=self.tokens[0],
            output_tokens=self.tokens[1],
            cost_usd=0.001,
            latency_s=0.0,
        )
        return LLMResponse(text=text, usage=usage, stop_reason="end_turn")


def make_llm(spec: str) -> LLM:
    """Build an LLM from "provider:model", e.g. "anthropic:claude-sonnet-5-5", "groq:llama-3.3-70b-versatile",
    "openai:gpt-4o-mini", "openrouter:anthropic/claude-sonnet-5-5". A bare "claude-*" means Anthropic.
    Any keyed OpenAI-compatible provider in providers.ENDPOINTS works the same way (gemini, together, ...).
    `compat:<model>@<base_url>` targets any OpenAI-compatible server (key from OPENAI_API_KEY)."""
    if ":" not in spec:
        if spec.startswith("claude"):
            return AnthropicLLM(spec)
        raise ValueError(f"LLM spec must look like 'provider:model', got {spec!r}")
    provider, model = spec.split(":", 1)
    provider = provider.lower()
    if provider == "anthropic":
        return AnthropicLLM(model or DEFAULT_ANTHROPIC_MODEL)
    if provider in _OPENAI_COMPAT:
        base, env, max_tokens_param = _OPENAI_COMPAT[provider]
        return OpenAICompatLLM(model, base_url=base, api_key_env=env, max_tokens_param=max_tokens_param)
    if provider == "compat":
        if "@" not in model:
            raise ValueError("compat spec must look like 'compat:<model>@<base_url>'")
        m, base = model.split("@", 1)
        return cast(LLM, OpenAICompatLLM(m, base_url=base))
    raise ValueError(f"unknown LLM provider {provider!r}")
