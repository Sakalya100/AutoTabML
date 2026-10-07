"""The free-tier provider pool (docs/AGENTIC_PLAN.md §12): which provider serves which model alias, at what
limits and list price.

Aliases, not provider names, are what roles ask for:
  code    gpt-oss-120b          Groq <-> Cerebras
  reason  gpt-oss-120b, reasoning_effort=medium, Groq (Cerebras: qwen). Qwen 3.8 on Groq is opt-in via
          AUTOTINKER_REASON_MODEL=qwen: Groq's free tier allows qwen only ~1K output tokens/min, which its own
          reasoning exhausts (measured 2026-10-07: 12 of 21 calls hit 429).
  fast    gemini flash-lite     Gemini            (falls back to `code`)
  judge   any of the above, preferring a provider other than the caller's (cross-check)

Keys are read from the environment by name only; nothing here ever logs or returns a key value.
Providers listed in AUTOTINKER_DISABLED_PROVIDERS (comma-separated; default "cerebras") are never called.
"""

from __future__ import annotations

import os
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
        ),
    },
)

CEREBRAS = ProviderSpec(
    name="cerebras",
    base_url="https://api.cerebras.ai/v1",
    key_env="CEREBRAS_API_KEY",
    max_tokens_param="max_completion_tokens",
    models={
        "code": ModelSpec("gpt-oss-120b", tpm=60000, rpm=5, max_output=32768, price=(0.25, 0.69, 0.25)),
        "reason": ModelSpec("qwen-3.8-27b", tpm=60000, rpm=5, max_output=16384, price=(0.40, 0.80, 0.40)),
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
    },
)

DEFAULT_PROVIDERS: tuple[ProviderSpec, ...] = (GROQ, GEMINI, CEREBRAS)


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
)


def _with_reason_model(p: ProviderSpec, e: Mapping[str, str]) -> ProviderSpec:
    if p.name != "groq" or e.get("AUTOTINKER_REASON_MODEL", "").strip().lower() == "qwen":
        return p
    return replace(p, models={**p.models, "reason": GROQ_REASON_DEFAULT})


def available_providers(
    providers: tuple[ProviderSpec, ...] | list[ProviderSpec] = DEFAULT_PROVIDERS,
    env: Mapping[str, str] | None = None,
) -> list[ProviderSpec]:
    """Providers that are enabled and have a key set (the key itself is never returned)."""
    e = os.environ if env is None else env
    off = disabled_providers(e)
    return [_with_reason_model(p, e) for p in providers if p.name not in off and e.get(p.key_env)]


def would_be_cost(spec: ModelSpec, tokens_in: int, tokens_out: int, tokens_cached: int = 0) -> float:
    pin, pout, pcache = spec.price
    uncached = max(tokens_in - tokens_cached, 0)
    return (uncached * pin + tokens_cached * pcache + tokens_out * pout) / 1e6
