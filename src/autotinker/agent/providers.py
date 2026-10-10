"""The free-tier provider pool (docs/AGENTIC_PLAN.md §12): which provider serves which model alias, at what
limits and list price.

Aliases, not provider names, are what roles ask for:
  code    gpt-oss-120b          Groq <-> Cerebras, then Gemini 3.5 Flash-Lite (no data rows)
  reason  gpt-oss-120b, reasoning_effort=medium, Groq (Cerebras: qwen). Qwen 3.8 on Groq is opt-in via
          AUTOTINKER_REASON_MODEL=qwen: Groq's free tier allows qwen only ~1K output tokens/min, which its own
          reasoning exhausts (measured 2026-10-07: 12 of 21 calls hit 429).
  fast    gemini flash-lite     Gemini            (falls back to `code`)
  judge   any of the above, preferring a provider other than the caller's (cross-check)

Keys are read from the environment by name only; nothing here ever logs or returns a key value.
Providers listed in AUTOTINKER_DISABLED_PROVIDERS (comma-separated; default "cerebras") are never called.

Bring your own model (`autotinker run --llm <spec>` or AUTOTINKER_LLM=<spec>; the flag wins). When set, every
alias (code, reason, fast, judge) is served by that one model and the free pool is not used.
`--fast-llm <spec>` / AUTOTINKER_FAST_LLM serves `fast` with a second model (`fast` still falls back to the
main model, and the judge picks from both). Specs are `provider:model`:

  openai:<model>      https://api.openai.com/v1                                 OPENAI_API_KEY
  anthropic:<model>   https://api.anthropic.com/v1 (OpenAI-compatible endpoint)  ANTHROPIC_API_KEY
  groq:<model>        https://api.groq.com/openai/v1                            GROQ_API_KEY
  gemini:<model>      https://generativelanguage.googleapis.com/v1beta/openai   GEMINI_API_KEY
  cerebras:<model>    https://api.cerebras.ai/v1                                CEREBRAS_API_KEY
  openrouter:<model>  https://openrouter.ai/api/v1                              OPENROUTER_API_KEY
  together:<model>    https://api.together.xyz/v1                               TOGETHER_API_KEY
  mistral:<model>     https://api.mistral.ai/v1                                 MISTRAL_API_KEY
  deepseek:<model>    https://api.deepseek.com/v1                               DEEPSEEK_API_KEY
  ollama:<model>      http://localhost:11434/v1 (or $OLLAMA_BASE_URL)           no key
  compat:<model>@<base_url>  any OpenAI-compatible server     AUTOTINKER_LLM_API_KEY if set, else no key

The model must support OpenAI-style tool calling (the judge forces a tool call). A provider that needs a key
and has none set is an error before the run starts (LLMSpecError, naming the variable).

Privacy: the rule "never send data rows to a provider that trains on inputs" is about the FREE pool
(Gemini's free tier). With a model you bring, you chose the provider, so the Intake and Profiler agents may
send it a few sample rows. AUTOTINKER_NO_ROWS=1 forces schema-only prompts for every provider, free pool or
your own.

Limits and cost for your own model: on Groq / Gemini / Cerebras, models the pool already knows keep their
free-tier rate limits and list prices, every model there costs $0 actual (free tier assumed; the would-be
cost is still shown) and the real limits are learned from rate-limit headers. Any other provider gets no
rate-limit buckets (429s are retried with the usual backoff) and is charged at its list price when known
(llm.PRICES or a pool ModelSpec), else $0 with price_known=false in usage and a note in the router log.
`reasoning_effort` is sent only to models known to accept it: gpt-oss on Groq / Cerebras, and OpenAI's
o-series and gpt-5*.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace

Alias = str  # "code" | "reason" | "fast" | "judge"

ALIAS_FALLBACK: dict[str, list[str]] = {
    "code": [],
    "reason": ["code"],
    "fast": ["code"],
    "judge": [],  # resolved specially by the router: every alias, other providers first
}

DEFAULT_DISABLED = "cerebras"  # 402 payment_required on the current key; re-enable via the env var


@dataclass(frozen=True)
class ModelSpec:
    """One model as served by one provider."""

    model_id: str
    tpm: int | None = None  # tokens per minute (prompt + max_tokens on Groq)
    rpm: int | None = None
    rpd: int | None = None
    max_output: int = 8192
    # list price, USD per million tokens (input, output, cached input). Used for the would-be cost.
    price: tuple[float, float, float] = (0.0, 0.0, 0.0)
    reasoning_format: bool = False  # Groq qwen: supports reasoning_format=parsed|hidden|raw
    reasoning_effort: str | None = None  # default effort sent when the role does not override it
    accepts_reasoning_effort: bool = False  # only then is `reasoning_effort` sent at all
    price_known: bool = True  # False -> `price` is a placeholder (0) for a model we have no list price for


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    base_url: str
    key_env: str
    models: dict[Alias, ModelSpec]
    max_tokens_param: str = "max_tokens"
    trains_on_inputs: bool = False  # True -> never send data rows (privacy rule)
    free_tier: bool = True  # actual cost is $0 while on the free tier
    extra_headers: dict[str, str] = field(default_factory=dict)
    byo: bool = False  # the user's own model (--llm): not subject to AUTOTINKER_DISABLED_PROVIDERS
    learn_limits: bool = True  # feed the rate-limit bucket from x-ratelimit-* headers


# Prices are approximate public list prices (2026-10); only used to show a "would-be" cost.
GROQ = ProviderSpec(
    name="groq",
    base_url="https://api.groq.com/openai/v1",
    key_env="GROQ_API_KEY",
    models={
        "code": ModelSpec(
            "openai/gpt-oss-120b",
            tpm=8000,
            rpm=30,
            rpd=1000,
            max_output=65536,
            price=(0.15, 0.60, 0.075),
            reasoning_effort="low",
            accepts_reasoning_effort=True,
        ),
        "reason": ModelSpec(
            "qwen/qwen3.8-27b",
            tpm=8000,
            rpm=30,
            rpd=1000,
            max_output=16384,
            price=(0.29, 0.59, 0.29),
            reasoning_format=True,
            reasoning_effort="default",
            accepts_reasoning_effort=True,
        ),
    },
)

CEREBRAS = ProviderSpec(
    name="cerebras",
    base_url="https://api.cerebras.ai/v1",
    key_env="CEREBRAS_API_KEY",
    max_tokens_param="max_completion_tokens",
    models={
        "code": ModelSpec(
            "gpt-oss-120b",
            tpm=60000,
            rpm=5,
            max_output=32768,
            price=(0.25, 0.69, 0.25),
            accepts_reasoning_effort=True,
        ),
        "reason": ModelSpec(
            "qwen-3.8-27b",
            tpm=60000,
            rpm=5,
            max_output=16384,
            price=(0.40, 0.80, 0.40),
            accepts_reasoning_effort=True,
        ),
    },
)

GEMINI = ProviderSpec(
    name="gemini",
    base_url="https://generativelanguage.googleapis.com/v1beta/openai",
    key_env="GEMINI_API_KEY",
    trains_on_inputs=True,
    models={
        "fast": ModelSpec(
            "gemini-3.1-flash-lite", tpm=250000, rpm=15, rpd=500, max_output=8192, price=(0.10, 0.40, 0.025)
        ),
        # Last-resort fallbacks for when Groq's free daily quota is used up (seen live 2026-10-08). A separate
        # Flash-Lite keeps them off the `fast` quota. Never gets data rows (only Intake/Profiler send rows;
        # `privacy=True` requests never go to providers that train on inputs).
        "code": ModelSpec(
            "gemini-3.5-flash-lite", tpm=250000, rpm=15, rpd=500, max_output=8192, price=(0.10, 0.40, 0.025)
        ),
        "reason": ModelSpec(
            "gemini-3.5-flash-lite", tpm=250000, rpm=15, rpd=500, max_output=8192, price=(0.10, 0.40, 0.025)
        ),
    },
)

# Order = preference for a shared alias: Gemini last, as the weaker, train-on-inputs fallback for code/reason.
DEFAULT_PROVIDERS: tuple[ProviderSpec, ...] = (GROQ, CEREBRAS, GEMINI)


def disabled_providers(env: Mapping[str, str] | None = None) -> set[str]:
    e = os.environ if env is None else env
    raw = e.get("AUTOTINKER_DISABLED_PROVIDERS", DEFAULT_DISABLED)
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


# Default `reason` model on Groq. Qwen 3.8 is opt-in (AUTOTINKER_REASON_MODEL=qwen): on the Groq free tier
# it gets ~1K output tokens/min, which its reasoning exhausts (2026-10-07: 12 of 21 calls hit 429).
GROQ_REASON_DEFAULT = ModelSpec(
    "openai/gpt-oss-120b",
    tpm=8000,
    rpm=30,
    rpd=1000,
    max_output=65536,
    price=(0.15, 0.60, 0.075),
    reasoning_effort="medium",
    accepts_reasoning_effort=True,
)


def _with_reason_model(p: ProviderSpec, e: Mapping[str, str]) -> ProviderSpec:
    if p.byo or p.name != "groq" or e.get("AUTOTINKER_REASON_MODEL", "").strip().lower() == "qwen":
        return p
    return replace(p, models={**p.models, "reason": GROQ_REASON_DEFAULT})


def available_providers(
    providers: tuple[ProviderSpec, ...] | list[ProviderSpec] = DEFAULT_PROVIDERS,
    env: Mapping[str, str] | None = None,
) -> list[ProviderSpec]:
    """Providers that are enabled and have a key set (the key itself is never returned). The user's own
    models (byo) are always kept: their keys were checked when the spec was resolved, and some need none."""
    e = os.environ if env is None else env
    off = disabled_providers(e)
    return [_with_reason_model(p, e) for p in providers if p.byo or (p.name not in off and e.get(p.key_env))]


def would_be_cost(spec: ModelSpec, tokens_in: int, tokens_out: int, tokens_cached: int = 0) -> float:
    pin, pout, pcache = spec.price
    uncached = max(tokens_in - tokens_cached, 0)
    return (uncached * pin + tokens_cached * pcache + tokens_out * pout) / 1e6


# ---------------------------------------------------------------- bring your own model


@dataclass(frozen=True)
class Endpoint:
    """An OpenAI-compatible /chat/completions endpoint, by provider name. Shared with llm.make_llm."""

    base_url: str
    key_env: str  # "" -> no key needed (no Authorization header is sent)
    max_tokens_param: str = "max_tokens"
    base_url_env: str = ""  # an env var that overrides base_url (Ollama)


ENDPOINTS: dict[str, Endpoint] = {
    "openai": Endpoint("https://api.openai.com/v1", "OPENAI_API_KEY", "max_completion_tokens"),
    "anthropic": Endpoint("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "groq": Endpoint(GROQ.base_url, GROQ.key_env, GROQ.max_tokens_param),
    "gemini": Endpoint(GEMINI.base_url, GEMINI.key_env, GEMINI.max_tokens_param),
    "cerebras": Endpoint(CEREBRAS.base_url, CEREBRAS.key_env, CEREBRAS.max_tokens_param),
    "openrouter": Endpoint("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "together": Endpoint("https://api.together.xyz/v1", "TOGETHER_API_KEY"),
    "mistral": Endpoint("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
    "deepseek": Endpoint("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
    "ollama": Endpoint("http://localhost:11434/v1", "", base_url_env="OLLAMA_BASE_URL"),
}
COMPAT_KEY_ENV = "AUTOTINKER_LLM_API_KEY"  # optional key for compat:<model>@<base_url>
LLM_ENV, FAST_LLM_ENV, NO_ROWS_ENV = "AUTOTINKER_LLM", "AUTOTINKER_FAST_LLM", "AUTOTINKER_NO_ROWS"

_HEURISTIC_HINT = (
    "The heuristic proposer has no tool calling, so it can't drive the agents. Use "
    "`autotinker evolve --llm heuristic` or `autotinker run --single-shot --llm heuristic`."
)


class LLMSpecError(ValueError):
    """A --llm / --fast-llm spec that cannot be used. `str(exc)` says what is wrong, `hint` what to do."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


@dataclass(frozen=True)
class LLMChoice:
    """A parsed spec. `key_env` names the key variable ("" = none); the key itself is never held here."""

    spec: str
    provider: str  # an ENDPOINTS name or "compat"
    model: str
    base_url: str
    key_env: str
    max_tokens_param: str = "max_tokens"


_COMPAT = re.compile(r"^(?P<model>.+?)@(?P<base>https?://\S+)$")


def _spec_hint() -> str:
    return (
        "Write it as provider:model, e.g. openai:gpt-4o-mini or groq:openai/gpt-oss-120b. Providers: "
        + ", ".join(ENDPOINTS)
        + ", or compat:<model>@<base_url> for any OpenAI-compatible server."
    )


def _ollama_base(url: str) -> str:
    base = url.strip().rstrip("/")
    return base if base.endswith("/v1") else base + "/v1"


def parse_llm_spec(spec: str, env: Mapping[str, str] | None = None) -> LLMChoice:
    """Parse `provider:model` or `compat:<model>@<base_url>` (no key check; see byo_providers)."""
    e = os.environ if env is None else env
    s = spec.strip()
    if s.lower() == "heuristic":
        raise LLMSpecError("'heuristic' can't be used as the agents' model.", _HEURISTIC_HINT)
    provider, sep, model = s.partition(":")
    provider, model = provider.strip().lower(), model.strip()
    if not sep or not provider or not model:
        raise LLMSpecError(f"The model spec {spec!r} isn't provider:model.", _spec_hint())
    if provider == "compat":
        m = _COMPAT.match(model)
        if m is None:
            raise LLMSpecError(
                f"The model spec {spec!r} isn't compat:<model>@<base_url>.",
                "Example: compat:llama3.1@http://localhost:8000/v1 (the base URL ends before "
                "/chat/completions and starts with http:// or https://).",
            )
        return LLMChoice(s, "compat", m["model"], m["base"].rstrip("/"), COMPAT_KEY_ENV)
    ep = ENDPOINTS.get(provider)
    if ep is None:
        raise LLMSpecError(f"Unknown model provider {provider!r} in {spec!r}.", _spec_hint())
    base = ep.base_url
    if ep.base_url_env and e.get(ep.base_url_env, "").strip():
        base = _ollama_base(e[ep.base_url_env])
    return LLMChoice(s, provider, model, base, ep.key_env, ep.max_tokens_param)


def resolve_llm_specs(
    llm: str | None = None, fast_llm: str | None = None, env: Mapping[str, str] | None = None
) -> tuple[str | None, str | None]:
    """(llm, fast_llm) from the arguments, else from AUTOTINKER_LLM / AUTOTINKER_FAST_LLM.
    (None, None) means the free pool."""
    e = os.environ if env is None else env
    main = (llm or "").strip() or e.get(LLM_ENV, "").strip() or None
    fast = (fast_llm or "").strip() or e.get(FAST_LLM_ENV, "").strip() or None
    if fast and not main:
        raise LLMSpecError(
            "A fast model was given (--fast-llm / AUTOTINKER_FAST_LLM) without a main model.",
            "Also pass --llm (or set AUTOTINKER_LLM); the fast model only serves the quick, cheap calls.",
        )
    return main, fast


def rows_allowed(env: Mapping[str, str] | None = None) -> bool:
    """False when AUTOTINKER_NO_ROWS is set: no prompt may contain data rows, whatever the provider."""
    e = os.environ if env is None else env
    return e.get(NO_ROWS_ENV, "").strip().lower() not in ("1", "true", "yes", "on")


_POOL: dict[str, ProviderSpec] = {p.name: p for p in DEFAULT_PROVIDERS}
_EFFORT_OPENAI = re.compile(r"^(o\d|gpt-5)")


def accepts_reasoning_effort(provider: str, model: str) -> bool:
    """Models known to accept `reasoning_effort`: gpt-oss on Groq / Cerebras; OpenAI o-series and gpt-5*."""
    m = model.lower()
    if provider in ("groq", "cerebras"):
        return "gpt-oss" in m
    if provider == "openai":
        return bool(_EFFORT_OPENAI.match(m))
    return False


def _pool_model(provider: str | None, model: str) -> ModelSpec | None:
    """The pool's ModelSpec for this model id (on this provider; any provider when `provider` is None)."""
    pools = [_POOL[provider]] if provider in _POOL else ([] if provider else list(_POOL.values()))
    for p in pools:
        for m in (*p.models.values(), GROQ_REASON_DEFAULT if p.name == "groq" else None):
            if m is not None and m.model_id == model:
                return m
    return None


def _list_price(model: str) -> tuple[float, float, float] | None:
    from autotinker.agent.llm import price_for  # llm.py imports this module

    for name in (model, model.rsplit("/", 1)[-1]):  # openrouter-style "openai/gpt-4o-mini"
        p = price_for(name)
        if p is not None:
            return (p[0], p[1], p[0])  # no cached-input discount assumed
    pool = _pool_model(None, model)
    return pool.price if pool is not None else None


def byo_model_spec(choice: LLMChoice) -> ModelSpec:
    """The pool's spec if the pool knows this provider + model (limits, price, reasoning), else no limits."""
    known = _pool_model(choice.provider, choice.model) if choice.provider in _POOL else None
    if known is not None:
        return known
    price = _list_price(choice.model)
    return ModelSpec(
        choice.model,
        price=price or (0.0, 0.0, 0.0),
        price_known=price is not None,
        accepts_reasoning_effort=accepts_reasoning_effort(choice.provider, choice.model),
    )


def _require_key(choice: LLMChoice, e: Mapping[str, str]) -> None:
    if choice.provider == "compat" or not choice.key_env or e.get(choice.key_env, "").strip():
        return
    raise LLMSpecError(
        f"{choice.key_env} is not set, so the model {choice.spec} can't be used.",
        f"Set {choice.key_env} in the environment or in ./.env, or leave out --llm / AUTOTINKER_LLM "
        "to use the free Groq and Gemini models.",
    )


def byo_providers(
    llm: str, fast_llm: str | None = None, env: Mapping[str, str] | None = None
) -> list[ProviderSpec]:
    """The provider list for your own model(s): `llm` serves code / reason (and fast, unless `fast_llm` is
    given, which then serves fast). Raises LLMSpecError for a bad spec or a missing key."""
    e = os.environ if env is None else env
    main = parse_llm_spec(llm, e)
    fast = parse_llm_spec(fast_llm, e) if fast_llm else None
    plan: list[tuple[LLMChoice, tuple[str, ...]]] = [
        (main, ("code", "reason") if fast else ("code", "reason", "fast"))
    ]
    if fast is not None:
        plan.append((fast, ("fast",)))
    out: list[ProviderSpec] = []
    for choice, aliases in plan:
        _require_key(choice, e)
        model = byo_model_spec(choice)
        out.append(
            ProviderSpec(
                name=choice.provider,
                base_url=choice.base_url,
                key_env=choice.key_env,
                models=dict.fromkeys(aliases, model),
                max_tokens_param=choice.max_tokens_param,
                trains_on_inputs=False,  # the user chose this provider (AUTOTINKER_NO_ROWS still applies)
                free_tier=choice.provider in _POOL,  # the pool's providers are assumed on their free tier
                byo=True,
                learn_limits=choice.provider in _POOL,
            )
        )
    return out
