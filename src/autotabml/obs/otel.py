"""Optional OpenTelemetry spans: run > experiment > {llm_call, sandbox}.

Active only when `opentelemetry` is importable (`pip install autotabml[otel]`); otherwise every span is a
no-op. Exporter configuration is left to the standard OTEL_* environment variables / SDK setup.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

try:  # pragma: no cover - depends on the optional extra
    from opentelemetry import trace as _trace

    _TRACER: Any = _trace.get_tracer("autotabml")
except Exception:  # ImportError or a broken install
    _TRACER = None


def enabled() -> bool:
    return _TRACER is not None


def _clean(attrs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in attrs.items():
        if v is None:
            continue
        out[k] = v if isinstance(v, str | bool | int | float) else str(v)
    return out


@contextlib.contextmanager
def span(name: str, **attrs: Any) -> Iterator[Any]:
    """Context manager yielding the span (or None). Use `set_attrs(sp, ...)` to add attributes later."""
    if _TRACER is None:
        yield None
        return
    with _TRACER.start_as_current_span(name, attributes=_clean(attrs)) as sp:  # pragma: no cover
        yield sp


def set_attrs(sp: Any, **attrs: Any) -> None:
    if sp is None:
        return
    for k, v in _clean(attrs).items():  # pragma: no cover
        sp.set_attribute(k, v)
