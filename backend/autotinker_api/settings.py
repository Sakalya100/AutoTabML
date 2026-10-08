"""Configuration from the environment.

Locally (not on Vercel) the backend also reads the repo-root `.env` (provider keys, DATABASE_URL*) and
`web/.env.local` (AUTOTINKER_SESSION_SECRET, kept there so the old Next.js backend's cookies stay valid), without
overriding anything already set in the process environment. Values are never logged.

Secrets this process holds (provider keys, DATABASE_URL*, AUTOTINKER_SESSION_SECRET, the protection-bypass secret)
never reach the engine: the local runner builds the engine's environment from an allow-list (`engine_env`), and the
sandbox runner only passes placeholders (the real provider keys are injected by the sandbox firewall).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

PROVIDER_KEYS = ("GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY")
_ENGINE_SETTING = re.compile(r"^AUTOTINKER_[A-Z0-9_]+$")
_CREDENTIAL = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|DATABASE)")
# Set to "" in the engine's environment so the engine's own .env loader (python-dotenv, override=False) can't pick
# them up from the repo-root .env.
BLOCKED_FROM_DOTENV = (
    "DATABASE_URL",
    "DATABASE_URL_POOLED",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "ANTHROPIC_API_KEY",
    "AUTOTINKER_SESSION_SECRET",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
)
_ENV_ALLOW = re.compile(
    r"^(PATH|HOME|USER|LANG|LC_[A-Z]+|TMPDIR|TEMP|TMP|SHELL|UV_[A-Z_]+|PYTHON[A-Z_]*|VIRTUAL_ENV|CONDA_[A-Z_]+"
    r"|SYSTEMROOT|OMP_NUM_THREADS)$"
)
# What the dotenv loader may take from web/.env.local (the rest of that file belongs to the frontend).
_WEB_ENV_NAMES = {"AUTOTINKER_SESSION_SECRET", "DATABASE_URL", "DATABASE_URL_POOLED", "DATABASE_URL_UNPOOLED"}

_loaded = False


def parse_dotenv(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        else:
            v = re.sub(r"\s+#.*$", "", v)
        out[m.group(1)] = v
    return out


def on_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))


def load_env_files() -> None:
    """Fill os.environ from the repo-root .env and web/.env.local (dev only; never overrides; idempotent)."""
    global _loaded
    if _loaded or on_vercel() or os.environ.get("AUTOTINKER_NO_DOTENV") == "1":
        _loaded = True
        return
    _loaded = True
    # A database chosen in the process environment wins as a whole: don't mix in another one's pooled/direct URL.
    db_from_env = any(os.environ.get(k) for k in ("DATABASE_URL", "DATABASE_URL_POOLED", "DATABASE_URL_UNPOOLED"))
    for path, allowed in ((REPO_ROOT / ".env", None), (REPO_ROOT / "web" / ".env.local", _WEB_ENV_NAMES)):
        try:
            values = parse_dotenv(path.read_text())
        except OSError:
            continue
        for k, v in values.items():
            if db_from_env and k.startswith("DATABASE_URL"):
                continue
            if (allowed is None or k in allowed) and v and not os.environ.get(k):
                os.environ[k] = v


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name) or default)
    except ValueError:
        return default


def database_url() -> str | None:
    return env("DATABASE_URL_POOLED") or env("DATABASE_URL")


def migration_database_url() -> str | None:
    """Migrations prefer the direct (unpooled) connection: they run multi-statement DDL in a transaction."""
    return env("DATABASE_URL_UNPOOLED") or env("DATABASE_URL") or env("DATABASE_URL_POOLED")


def live_runs_enabled() -> bool:
    return env("AUTOTINKER_LIVE_RUNS") != "0"


def runner_kind() -> str:
    """AUTOTINKER_RUNNER=local|sandbox (vercel-sandbox accepted). Default: sandbox on Vercel, local elsewhere."""
    v = (env("AUTOTINKER_RUNNER") or "").lower()
    if v in ("sandbox", "vercel-sandbox"):
        return "sandbox"
    if v == "local":
        return "local"
    return "sandbox" if on_vercel() else "local"


def engine_env() -> dict[str, str]:
    """The engine's environment for the local runner: system basics, provider keys and AUTOTINKER_* settings that
    don't look like credentials. Never DATABASE_URL, the session secret or any other credential."""
    out: dict[str, str] = {k: v for k, v in os.environ.items() if _ENV_ALLOW.match(k)}
    for k, v in os.environ.items():
        if not v:
            continue
        if k in PROVIDER_KEYS or (_ENGINE_SETTING.match(k) and not _CREDENTIAL.search(k)):
            out[k] = v
    for k in BLOCKED_FROM_DOTENV:
        out[k] = ""
    out["PYTHONUNBUFFERED"] = "1"
    return out


def known_secrets() -> list[str]:
    """Every secret value this process knows, for redacting logs and error tails."""
    names = (
        *PROVIDER_KEYS,
        "AUTOTINKER_SESSION_SECRET",
        "DATABASE_URL",
        "DATABASE_URL_POOLED",
        "DATABASE_URL_UNPOOLED",
        "VERCEL_AUTOMATION_BYPASS_SECRET",
    )
    return [v for v in (env(k) for k in names) if v]


# Provider-key shapes (Anthropic, Groq, Google, Cerebras, Neon passwords) and bearer tokens. The prefixes are
# assembled so that secret scanners grepping the source for them don't flag this file.
_KEY_PATTERNS = [
    re.compile(p)
    for p in (
        "sk-" + r"ant-[A-Za-z0-9_-]{8,}",
        "gsk" + r"_[A-Za-z0-9]{8,}",
        r"\bAQ" + r"\.[A-Za-z0-9_-]{8,}",
        "AI" + r"za[A-Za-z0-9_-]{20,}",
        "csk" + r"-[A-Za-z0-9]{8,}",
        "npg" + r"_[A-Za-z0-9]{6,}",
        r"Bearer\s+\S+",
    )
]


def redact(text: str, secrets: list[str] | None = None) -> str:
    """Drop known secret values and anything shaped like a provider key or bearer token."""
    out = text
    for s in known_secrets() if secrets is None else secrets:
        if s and len(s) >= 8:
            out = out.replace(s, "[redacted]")
    for pat in _KEY_PATTERNS:
        out = pat.sub("[redacted]", out)
    return out
