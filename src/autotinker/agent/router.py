"""Model router over the free-tier provider pool (docs/AGENTIC_PLAN.md §12).

Every agent call goes through `Router.chat(ChatRequest)`:
  * the role asks for a model *alias* (code / reason / fast / judge); the router picks a provider + model
  * a token bucket per (provider, model) is fed from `x-ratelimit-*` headers and known limits; requests are
    measured before sending (chars / 3.5 + max_tokens, which is what Groq's TPM counts) and sent to a
    provider whose window fits, waiting for a refill when that is cheaper than failing over
  * 429 -> honour retry-after / Gemini RetryInfo, fail over; 402 / 401 / 403 / per-day quota -> provider down
    for the rest of the process ("for the day"); 413 -> does not fit that provider, fail over;
    5xx / timeout -> back off and fail over
  * `privacy=True` (the request contains data rows) -> never routed to a provider that trains on inputs, and
    never sent at all when AUTOTINKER_NO_ROWS is set
  * per-call usage: provider, model, tokens in/out/cached, latency, would-be cost; actual cost is $0 on
    free tiers
  * `llm=` / AUTOTINKER_LLM (and `fast_llm=` / AUTOTINKER_FAST_LLM): the user's own model serves every alias
    instead of the free pool (providers.byo_providers; the module docstring there has the details)

API keys are held privately and never logged, returned or put into errors.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from autotinker.agent.llm import LLMAuthError, LLMError
from autotinker.agent.providers import (
    ALIAS_FALLBACK,
    DEFAULT_PROVIDERS,
    ModelSpec,
    ProviderSpec,
    available_providers,
    byo_providers,
    resolve_llm_specs,
    rows_allowed,
    would_be_cost,
)

CHARS_PER_TOKEN = 3.5
MIN_MAX_TOKENS = 512


def estimate_tokens(text: str) -> int:
    """Tokenizer-free estimate (chars / 3.5), deliberately a little pessimistic."""
    return int(math.ceil(len(text) / CHARS_PER_TOKEN)) + 8


def estimate_request_tokens(system: str, messages: list[dict[str, Any]], tools: list[Any] | None) -> int:
    n = estimate_tokens(system)
    for m in messages:
        c = m.get("content")
        n += estimate_tokens(c if isinstance(c, str) else json.dumps(c)) + 4
    if tools:
        n += estimate_tokens(json.dumps(tools))
    return n


_DUR = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


def parse_duration(text: str | None) -> float | None:
    """'1m26.4s' -> 86.4, '4.065s' -> 4.065, '120ms' -> 0.12, '7' -> 7.0. None if unparseable."""
    if text is None:
        return None
    t = str(text).strip()
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        pass
    total, matched = 0.0, False
    for num, unit in _DUR.findall(t):
        matched = True
        v = float(num)
        total += {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}[unit] * v
    return total if matched else None


def _find_retry_delay(obj: Any) -> float | None:
    """Gemini puts google.rpc.RetryInfo {retryDelay: '12s'} somewhere inside error.details."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "retryDelay":
                return parse_duration(str(v))
            found = _find_retry_delay(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_retry_delay(v)
            if found is not None:
                return found
    return None


# ---------------------------------------------------------------- request / result


@dataclass
class ChatRequest:
    alias: str  # code | reason | fast | judge
    system: str
    messages: list[dict[str, Any]]
    max_tokens: int = 2048
    role: str = ""  # who is asking, for accounting
    privacy: bool = False  # True if the prompt contains data rows / cell values
    tools: list[dict[str, Any]] | None = None
    tool_choice: Any = None
    reasoning_effort: str | None = None
    avoid_provider: str | None = None  # prefer any other provider (judge cross-checks)
    temperature: float | None = None


@dataclass
class CallUsage:
    provider: str
    model: str
    alias: str
    role: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_cached: int = 0
    latency_s: float = 0.0
    cost_usd: float = 0.0
    would_be_cost_usd: float = 0.0
    fallbacks: list[str] = field(default_factory=list)  # "provider/model: why" for each failed attempt


@dataclass
class ChatResult:
    text: str
    usage: CallUsage
    reasoning: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None

    @property
    def provider(self) -> str:
        return self.usage.provider

    @property
    def model(self) -> str:
        return self.usage.model


class ChatBackend(Protocol):
    def chat(self, req: ChatRequest) -> ChatResult: ...


# ---------------------------------------------------------------- rate limiting


@dataclass
class Bucket:
    """Token + request bucket for one (provider, model). Tokens refill linearly at tpm / 60 per second."""

    tpm: int | None
    rpm: int | None
    rpd: int | None
    tokens: float = 0.0
    updated: float = 0.0
    recent: deque[float] = field(default_factory=deque)  # request timestamps in the last 60 s
    day_requests: int = 0
    blocked_until: float = 0.0
    max_request: int | None = None  # learned from "Request too large ... Limit N" (e.g. Groq output TPM)

    def __post_init__(self) -> None:
        self.tokens = float(self.tpm or 0)

    def _refill(self, now: float) -> None:
        if self.tpm is not None:
            self.tokens = min(float(self.tpm), self.tokens + (now - self.updated) * self.tpm / 60.0)
        self.updated = now
        while self.recent and now - self.recent[0] >= 60.0:
            self.recent.popleft()

    def wait_for(self, need: int, now: float) -> float:
        """Seconds until a request of `need` tokens may be sent (inf if it can never fit)."""
        self._refill(now)
        if self.rpd is not None and self.day_requests >= self.rpd:
            return math.inf
        if self.tpm is not None and need > self.tpm:
            return math.inf
        w = max(self.blocked_until - now, 0.0)
        if self.tpm is not None and self.tokens < need:
            w = max(w, (need - self.tokens) * 60.0 / self.tpm)
        if self.rpm is not None and len(self.recent) >= self.rpm:
            w = max(w, 60.0 - (now - self.recent[0]))
        return w

    def consume(self, need: int, now: float) -> None:
        self._refill(now)
        if self.tpm is not None:
            self.tokens -= need
        self.recent.append(now)
        self.day_requests += 1

    def update_from_headers(self, headers: httpx.Headers, now: float) -> None:
        rem_t = headers.get("x-ratelimit-remaining-tokens")
        lim_t = headers.get("x-ratelimit-limit-tokens")
        if lim_t:
            with contextlib.suppress(ValueError):
                self.tpm = int(float(lim_t))
        if rem_t is not None:
            try:
                self.tokens = float(rem_t)
                self.updated = now
            except ValueError:
                pass
        rem_r = headers.get("x-ratelimit-remaining-requests")
        if rem_r is not None:
            try:
                if int(float(rem_r)) <= 0:
                    reset = parse_duration(headers.get("x-ratelimit-reset-requests")) or 60.0
                    self.blocked_until = max(self.blocked_until, now + reset)
            except ValueError:
                pass


# ---------------------------------------------------------------- the router


@dataclass
class _Candidate:
    provider: ProviderSpec
    alias: str
    model: ModelSpec

    @property
    def key(self) -> str:
        return f"{self.provider.name}/{self.model.model_id}"


class Router:
    """Implements ChatBackend over real providers. Not thread-safe (the orchestrator is sequential).

    With `llm` (or AUTOTINKER_LLM; the argument wins) and no explicit `providers`, every alias goes to that
    one model (`fast_llm` / AUTOTINKER_FAST_LLM: a second model for `fast`) and the free pool is not used.
    A bad spec or a missing key raises providers.LLMSpecError here, before any request is made."""

    def __init__(
        self,
        providers: list[ProviderSpec] | None = None,
        *,
        llm: str | None = None,
        fast_llm: str | None = None,
        env: dict[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout_s: float = 120.0,
        max_wait_s: float = 90.0,
        prefer_wait_s: float = 25.0,
        max_attempts: int = 8,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        on_wait: Callable[[str, float], None] | None = None,
    ) -> None:
        e = dict(os.environ) if env is None else env
        self.llm_choice: dict[str, str] | None = None  # {"llm": spec, "fast_llm": spec} for your own model
        main, fast = resolve_llm_specs(llm, fast_llm, e) if providers is None else (None, None)
        if main:
            self.providers = byo_providers(main, fast, e)
            self.llm_choice = {"llm": main, "fast_llm": fast or main}
        else:
            self.providers = available_providers(tuple(providers or DEFAULT_PROVIDERS), e)
        self._keys = {p.name: e.get(p.key_env, "") if p.key_env else "" for p in self.providers}
        self.send_rows = rows_allowed(e)  # False: AUTOTINKER_NO_ROWS, no data rows to any provider
        self.client = httpx.Client(timeout=timeout_s, transport=transport)
        self.max_wait_s = max_wait_s
        self.prefer_wait_s = prefer_wait_s
        self.max_attempts = max_attempts
        self._sleep = sleep
        self._clock = clock
        self.on_wait = on_wait
        self.buckets: dict[str, Bucket] = {}
        self.down: dict[str, str] = {}  # provider name -> reason (for the rest of the process)
        self.stats: dict[str, dict[str, Any]] = {}
        self.events: list[str] = []  # human-readable router log (waits, fail-overs, provider down)
        for p in self.providers if self.llm_choice else []:
            for m in {m.model_id: m for m in p.models.values()}.values():
                aliases = "/".join(a for a, x in p.models.items() if x.model_id == m.model_id)
                self._note(f"your model {p.name}/{m.model_id} serves {aliases}")
                if not m.price_known:
                    self._note(f"no list price known for {p.name}/{m.model_id}: its cost is reported as $0")

    def __repr__(self) -> str:  # never show keys
        return f"Router(providers={[p.name for p in self.providers]}, down={self.down})"

    @property
    def provider_names(self) -> list[str]:
        return list(dict.fromkeys(p.name for p in self.providers))

    def _bucket(self, c: _Candidate) -> Bucket:
        b = self.buckets.get(c.key)
        if b is None:
            b = Bucket(c.model.tpm, c.model.rpm, c.model.rpd)
            b.updated = self._clock()
            self.buckets[c.key] = b
        return b

    def _note(self, msg: str) -> None:
        # Provider error bodies can carry account ids (e.g. Groq's organization); keep them out of run.json.
        msg = re.sub(
            r"(organi[sz]ation|org|project|account)[ _`'\"]*[:=]?[ `'\"]*[A-Za-z0-9_\-]{6,}",
            r"\1 <redacted>",
            msg,
        )
        msg = re.sub(r"\borg_[A-Za-z0-9]{8,}", "org_<redacted>", msg)
        self.events.append(msg)

    # -------------------------------------------------- candidate selection

    def candidates(self, req: ChatRequest) -> list[_Candidate]:
        if req.privacy and not self.send_rows:
            return []  # AUTOTINKER_NO_ROWS: a request with data rows goes nowhere
        if req.alias == "judge":
            aliases = ["reason", "fast", "code"]
        else:
            aliases = [req.alias, *ALIAS_FALLBACK.get(req.alias, [])]
        out: list[_Candidate] = []
        for a in aliases:
            for p in self.providers:
                m = p.models.get(a)
                if m is None or p.name in self.down:
                    continue
                if req.privacy and p.trains_on_inputs:
                    continue
                out.append(_Candidate(p, a, m))
        if req.avoid_provider:
            other = [c for c in out if c.provider.name != req.avoid_provider]
            same = [c for c in out if c.provider.name == req.avoid_provider]
            out = other + same
        return out

    def _plan(self, c: _Candidate, est: int, max_tokens: int) -> tuple[int, int] | None:
        """(max_tokens to send, tokens to reserve), or None if the request cannot fit this window."""
        b = self._bucket(c)
        mt = min(max_tokens, c.model.max_output)
        if b.max_request is not None and mt > b.max_request:
            if b.max_request < min(MIN_MAX_TOKENS, max_tokens):
                return None
            mt = b.max_request - 16
        tpm = b.tpm
        if tpm is not None and est + mt > tpm:
            room = tpm - est - 64
            if room < min(MIN_MAX_TOKENS, max_tokens):
                return None
            mt = room
        return mt, est + mt

    # -------------------------------------------------- HTTP

    def _body(self, c: _Candidate, req: ChatRequest, max_tokens: int) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": c.model.model_id,
            "messages": [{"role": "system", "content": req.system}, *req.messages],
            c.provider.max_tokens_param: max_tokens,
        }
        if req.tools:
            body["tools"] = req.tools
            if req.tool_choice is not None:
                body["tool_choice"] = req.tool_choice
        if req.temperature is not None:
            body["temperature"] = req.temperature
        effort = req.reasoning_effort or c.model.reasoning_effort
        if c.model.reasoning_format:
            body["reasoning_format"] = "parsed"  # must be parsed/hidden with tools or JSON output
        if effort and c.model.accepts_reasoning_effort:
            body["reasoning_effort"] = effort
        return body

    def _send(self, c: _Candidate, body: dict[str, Any]) -> httpx.Response:
        headers = {"content-type": "application/json", **c.provider.extra_headers}
        key = self._keys.get(c.provider.name, "")
        if key:  # keyless endpoints (Ollama, an open compat server) get no Authorization header
            headers["authorization"] = f"Bearer {key}"
        return self.client.post(f"{c.provider.base_url}/chat/completions", headers=headers, json=body)

    def _record(self, c: _Candidate, *, ok: bool, usage: CallUsage | None = None, error: str = "") -> None:
        s = self.stats.setdefault(
            c.key,
            {
                "provider": c.provider.name,
                "model": c.model.model_id,
                "calls": 0,
                "errors": 0,
                "tokens_in": 0,
                "tokens_out": 0,
                "tokens_cached": 0,
                "would_be_cost_usd": 0.0,
                "cost_usd": 0.0,
                "latency_s": 0.0,
                "price_known": c.model.price_known,
                "roles": {},
                "error_kinds": {},
            },
        )
        if ok and usage is not None:
            s["calls"] += 1
            s["tokens_in"] += usage.tokens_in
            s["tokens_out"] += usage.tokens_out
            s["tokens_cached"] += usage.tokens_cached
            s["would_be_cost_usd"] += usage.would_be_cost_usd
            s["cost_usd"] += usage.cost_usd
            s["latency_s"] += usage.latency_s
            s["roles"][usage.role or "?"] = s["roles"].get(usage.role or "?", 0) + 1
        else:
            s["errors"] += 1
            s["error_kinds"][error] = s["error_kinds"].get(error, 0) + 1

    def _parse(self, c: _Candidate, req: ChatRequest, data: dict[str, Any], latency: float) -> ChatResult:
        choices = data.get("choices") or [{}]
        ch = choices[0] or {}
        msg = ch.get("message") or {}
        text = msg.get("content") or ""
        reasoning = msg.get("reasoning") or msg.get("reasoning_content") or None
        tool_calls = [tc for tc in (msg.get("tool_calls") or []) if isinstance(tc, dict)]
        u = data.get("usage") or {}
        tin, tout = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
        details = u.get("prompt_tokens_details") or {}
        cached = int((details.get("cached_tokens") if isinstance(details, dict) else 0) or 0)
        wb = would_be_cost(c.model, tin, tout, cached)
        usage = CallUsage(
            provider=c.provider.name,
            model=c.model.model_id,
            alias=c.alias,
            role=req.role,
            tokens_in=tin,
            tokens_out=tout,
            tokens_cached=cached,
            latency_s=latency,
            cost_usd=0.0 if c.provider.free_tier else wb,
            would_be_cost_usd=wb,
        )
        return ChatResult(
            text=text if isinstance(text, str) else json.dumps(text),
            usage=usage,
            reasoning=reasoning if isinstance(reasoning, str) else None,
            tool_calls=tool_calls,
            finish_reason=ch.get("finish_reason"),
        )

    # -------------------------------------------------- main entry

    def chat(self, req: ChatRequest) -> ChatResult:
        if req.privacy and not self.send_rows:
            raise LLMError("AUTOTINKER_NO_ROWS is set: a request with data rows is not sent to any provider")
        est = estimate_request_tokens(req.system, req.messages, req.tools)
        excluded: set[str] = set()  # candidates that cannot serve *this* request
        fallbacks: list[str] = []
        attempts = 0
        backoff = 1.0
        while attempts < self.max_attempts:
            cands = [c for c in self.candidates(req) if c.key not in excluded]
            if not cands:
                break
            now = self._clock()
            best: tuple[float, int, _Candidate, int, int] | None = None
            best_score = math.inf
            primary = cands[0].alias if req.alias == "judge" else req.alias
            for i, c in enumerate(cands):
                plan = self._plan(c, est, req.max_tokens)
                if plan is None:
                    excluded.add(c.key)
                    fallbacks.append(
                        f"{c.key}: prompt (~{est} tok) does not fit the {c.model.tpm} TPM window"
                    )
                    continue
                mt, need = plan
                w = self._bucket(c).wait_for(need, now)
                # Prefer the requested model (and, for judges, another provider): waiting up to
                # `prefer_wait_s` for it beats falling back at once.
                penalty = 0.0
                if c.alias != primary or (req.avoid_provider and c.provider.name == req.avoid_provider):
                    penalty = self.prefer_wait_s
                score = w + penalty
                if best is None or score < best_score:
                    best, best_score = (w, i, c, mt, need), score
                    if score == 0.0:
                        break
            if best is None:
                continue  # everything left was excluded this round; loop re-checks
            wait, _, c, mt, need = best
            if math.isinf(wait):
                excluded.add(c.key)
                fallbacks.append(f"{c.key}: daily request budget exhausted")
                continue
            if wait > self.max_wait_s:
                raise LLMError(
                    f"all providers for alias {req.alias!r} are rate-limited for {wait:.0f}s "
                    f"(> max_wait {self.max_wait_s:.0f}s)"
                )
            if wait > 0:
                self._note(f"wait {wait:.1f}s for {c.key} ({req.role or req.alias})")
                if self.on_wait is not None:
                    self.on_wait(c.key, wait)
                self._sleep(wait)
            attempts += 1
            bucket = self._bucket(c)
            bucket.consume(need, self._clock())
            body = self._body(c, req, mt)
            t0 = time.perf_counter()
            try:
                resp = self._send(c, body)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                why = f"{type(exc).__name__}"
                fallbacks.append(f"{c.key}: {why}")
                self._record(c, ok=False, error="timeout/transport")
                bucket.blocked_until = self._clock() + backoff
                backoff = min(backoff * 2, 30.0)
                continue
            latency = time.perf_counter() - t0
            now = self._clock()
            if c.provider.learn_limits:
                bucket.update_from_headers(resp.headers, now)
            code = resp.status_code
            if code < 400:
                try:
                    data = resp.json()
                except ValueError:
                    fallbacks.append(f"{c.key}: non-JSON response")
                    self._record(c, ok=False, error="bad_json")
                    excluded.add(c.key)
                    continue
                result = self._parse(c, req, data, latency)
                result.usage.fallbacks = fallbacks
                self._record(c, ok=True, usage=result.usage)
                return result
            snippet = resp.text[:300]
            self._record(c, ok=False, error=str(code))
            if code in (401, 402, 403):
                self.down[c.provider.name] = f"HTTP {code}"
                self._note(f"{c.provider.name} marked down for the day (HTTP {code})")
                fallbacks.append(f"{c.key}: HTTP {code} -> provider down")
                continue
            if code == 413:
                excluded.add(c.key)
                fallbacks.append(f"{c.key}: HTTP 413 request too large")
                continue
            if code == 429 and "request too large" in snippet.lower():
                # e.g. Groq: "Request too large for model ... on output tokens per minute: Limit 6000, ..."
                m = re.search(r"Limit\s+(\d+)", resp.text)
                if m and "output" in snippet.lower():
                    bucket.max_request = int(m.group(1))
                    self._note(f"{c.key}: output-token window is {m.group(1)}; max_tokens will be clamped")
                else:
                    excluded.add(c.key)
                fallbacks.append(f"{c.key}: 429 request too large")
                continue
            if code == 429:
                low = snippet.lower()
                per_day = "perday" in low.replace(" ", "") or "per day" in low
                if per_day or "insufficient_quota" in low:  # OpenAI: no credit left on the account
                    why = "daily quota exhausted" if per_day else "out of credit (insufficient_quota)"
                    self.down[c.provider.name] = why
                    self._note(f"{c.provider.name} {why} -> down for the day")
                    fallbacks.append(f"{c.key}: 429 {why} -> provider down")
                    continue
                delay = parse_duration(resp.headers.get("retry-after"))
                if delay is None:
                    try:
                        delay = _find_retry_delay(resp.json())
                    except ValueError:
                        delay = None
                delay = delay if delay is not None else min(backoff * 2, 30.0)
                bucket.blocked_until = now + delay
                self._note(f"{c.key} 429, retry in {delay:.1f}s: {snippet[:160]}")
                fallbacks.append(f"{c.key}: 429 (retry in {delay:.1f}s)")
                continue
            if code >= 500:
                bucket.blocked_until = now + backoff
                backoff = min(backoff * 2, 30.0)
                fallbacks.append(f"{c.key}: HTTP {code}")
                continue
            # other 4xx: this provider/model cannot serve this request as built; try the next one
            excluded.add(c.key)
            fallbacks.append(f"{c.key}: HTTP {code}: {snippet[:160]}")
        if not self.providers or all(p.name in self.down for p in self.providers):
            raise LLMAuthError(
                "no LLM provider is usable (missing keys, disabled, or rejected: "
                + ", ".join(f"{k}={v}" for k, v in self.down.items())
                + ")"
            )
        raise LLMError(f"no provider could serve alias {req.alias!r}: " + "; ".join(fallbacks[-6:]))

    def usage_summary(self) -> dict[str, Any]:
        return {
            "providers": self.provider_names,
            **({"llm": dict(self.llm_choice)} if self.llm_choice else {}),
            "down": dict(self.down),
            "by_model": {k: dict(v) for k, v in self.stats.items()},
            "log": self.events[-200:],
        }


# ---------------------------------------------------------------- test double


class ScriptedChat:
    """ChatBackend test double driven by ScriptedLLM queues of reply strings.

    `responses` is one queue (list / ScriptedLLM) shared by all roles, or a dict role -> queue (the judge's
    role is "judge"). Each reply is returned as the message content; when the request carries tools, it is
    returned as the arguments of a call to the first tool (so judge replies are JSON like {"choice": "A"}).
    Records every request (alias, role, privacy, messages) for assertions."""

    def __init__(self, responses: Any, *, provider: str = "scripted") -> None:
        from autotinker.agent.llm import ScriptedLLM

        def q(r: Any) -> ScriptedLLM:
            return r if isinstance(r, ScriptedLLM) else ScriptedLLM(list(r))

        self.queues: dict[str, ScriptedLLM] | None = None
        self.llm: ScriptedLLM | None = None
        if isinstance(responses, dict):
            self.queues = {k: q(v) for k, v in responses.items()}
        else:
            self.llm = q(responses)
        self.provider = provider
        self.provider_names = [provider]
        self.requests: list[ChatRequest] = []

    def chat(self, req: ChatRequest) -> ChatResult:
        self.requests.append(req)
        if self.queues is not None:
            llm = self.queues.get(req.role)
            if llm is None:
                raise LLMError(f"ScriptedChat: no queue for role {req.role!r}")
        else:
            assert self.llm is not None
            llm = self.llm
        resp = llm.complete(req.system, req.messages, max_tokens=req.max_tokens, purpose="propose")
        usage = CallUsage(
            provider=self.provider if req.alias != "judge" else f"{self.provider}-judge",
            model=f"scripted-{req.alias}",
            alias=req.alias,
            role=req.role,
            tokens_in=resp.usage.input_tokens,
            tokens_out=resp.usage.output_tokens,
            would_be_cost_usd=0.0001,
        )
        if req.tools:
            name = req.tools[0]["function"]["name"]
            call = {"id": "call_0", "type": "function", "function": {"name": name, "arguments": resp.text}}
            return ChatResult(text="", usage=usage, tool_calls=[call], finish_reason="tool_calls")
        return ChatResult(
            text=resp.text, usage=usage, reasoning=f"thinking as {req.role}", finish_reason="stop"
        )
