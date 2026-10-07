"""Role runner: one agent call -> validated structured output + an `AgentStep` record.

Every structured reply is checked with autoevals `ValidJSON` against the role's JSON schema and parsed with
pydantic; a failure triggers exactly one repair re-ask. Code replies (Coder, Debugger) are a ```python block
and are checked with `ast.parse` instead, also with one repair re-ask.
"""

from __future__ import annotations

import ast
import json
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Generic, Literal, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from autotinker.agent.evals import valid_json
from autotinker.agent.prompts import ParseError, parse_structured
from autotinker.agent.roles.schemas import CodeOut
from autotinker.agent.router import ChatBackend, ChatRequest, ChatResult
from autotinker.contracts import AgentStep

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class RoleSpec(Generic[T]):
    name: str  # intake | profiler | planner | coder | debugger | critic | tuner | ensembler | reporter
    alias: str  # code | reason | fast | judge
    system: str
    output: type[T]
    max_tokens: int = 2048
    kind: Literal["json", "code"] = "json"
    reasoning_effort: str | None = None


class StepObserver(Protocol):
    def step_started(self, exp_id: str | None, step: AgentStep) -> None: ...

    def step_reasoning(self, exp_id: str | None, step: AgentStep, text: str) -> None: ...

    def step_finished(self, exp_id: str | None, step: AgentStep) -> None: ...


class RoleFailed(RuntimeError):
    def __init__(self, msg: str, step: AgentStep):
        super().__init__(msg)
        self.step = step


@dataclass
class RoleCall(Generic[T]):
    output: T
    step: AgentStep
    results: list[ChatResult] = field(default_factory=list)


def _now() -> str:
    return datetime.now(UTC).isoformat()


_PY_FENCE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL)


def parse_code_reply(text: str) -> CodeOut:
    """Coder/Debugger reply: a plain sentence, then the whole file in one ```python block."""
    blocks = _PY_FENCE.findall(text)
    code = ""
    plain = ""
    if blocks:
        code = max(blocks, key=len)
        head = text[: text.find("```")].strip()
        plain = head.splitlines()[0] if head else ""
    else:
        try:
            obj = json.loads(text, strict=False)
            if isinstance(obj, dict) and isinstance(obj.get("code"), str):
                code, plain = obj["code"], str(obj.get("plain", ""))
        except json.JSONDecodeError:
            if "def build_pipeline" in text:
                code = text
    plain = re.sub(r"^(plain|summary|note)\s*:\s*", "", plain.strip(), flags=re.I).strip("# ").strip()
    if not code.strip():
        raise ParseError("no ```python code block found")
    try:
        ast.parse(code)
    except SyntaxError as exc:
        raise ParseError(f"the code does not parse: {exc.msg} (line {exc.lineno})") from exc
    if "def build_pipeline" not in code:
        raise ParseError("the code does not define build_pipeline(profile)")
    return CodeOut(code=code.strip() + "\n", plain=plain[:300])


def _json_candidate(text: str) -> str:
    s, e = text.find("{"), text.rfind("}")
    return text[s : e + 1] if s != -1 and e > s else text


def parse_reply(spec: RoleSpec[T], text: str) -> T:
    if spec.kind == "code":
        out = parse_code_reply(text)
        return spec.output.model_validate(out.model_dump())
    schema = spec.output.model_json_schema()
    # autoevals ValidJSON: is it JSON at all and does it carry the required keys?
    required_only = {"type": "object", "required": schema.get("required", [])}
    if not valid_json(_json_candidate(text), required_only) and not valid_json(text, required_only):
        # parse_structured is more lenient (fences, prose); let it try before declaring failure
        try:
            return parse_structured(text, spec.output)
        except ParseError as exc:
            raise ParseError(
                f"reply is not a JSON object with keys {schema.get('required', [])}: {exc}"
            ) from exc
    return parse_structured(text, spec.output)


def _repair_message(spec: RoleSpec[Any], err: str) -> dict[str, Any]:
    if spec.kind == "code":
        what = "one plain sentence, then the COMPLETE solution.py in a single ```python block"
    else:
        what = "ONLY the JSON object described above (valid JSON, double quotes, no trailing commas)"
    return {
        "role": "user",
        "content": f"Your reply could not be used ({err[:400]}). Reply again with {what}.",
    }


def _summary(text: str, n: int = 240) -> str:
    t = " ".join(text.split())
    return t if len(t) <= n else t[: n - 1] + "…"


def run_role(
    backend: ChatBackend,
    spec: RoleSpec[T],
    user: str,
    *,
    exp_id: str | None = None,
    attempt: int = 0,
    privacy: bool = False,
    avoid_provider: str | None = None,
    input_summary: str = "",
    observer: StepObserver | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> RoleCall[T]:
    """Call one role (with one repair re-ask). Raises RoleFailed (carrying the step) if both replies fail."""
    step = AgentStep(
        step_id=uuid.uuid4().hex[:10],
        role=spec.name,
        attempt=attempt,
        input_summary=input_summary or _summary(user),
        started_at=_now(),
    )
    if observer is not None:
        observer.step_started(exp_id, step)
    t0 = clock()
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    results: list[ChatResult] = []
    last_err = ""
    last_exc: Exception | None = None
    reasoning_parts: list[str] = []
    for i in range(2):
        try:
            res = backend.chat(
                ChatRequest(
                    alias=spec.alias,
                    system=spec.system,
                    messages=messages,
                    max_tokens=spec.max_tokens,
                    role=spec.name,
                    privacy=privacy,
                    reasoning_effort=spec.reasoning_effort,
                    avoid_provider=avoid_provider,
                )
            )
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            last_exc = exc
            break
        results.append(res)
        step.model, step.provider = res.model, res.provider
        step.tokens_in += res.usage.tokens_in
        step.tokens_out += res.usage.tokens_out
        step.tokens_cached += res.usage.tokens_cached
        step.cost_usd += res.usage.cost_usd
        step.would_be_cost_usd += res.usage.would_be_cost_usd
        if res.reasoning:
            reasoning_parts.append(res.reasoning)
            if observer is not None:
                observer.step_reasoning(exp_id, step, res.reasoning)
        try:
            if res.finish_reason == "length" and spec.kind == "code":
                raise ParseError("reply was cut off at the token limit; write a shorter file")
            out = parse_reply(spec, res.text)
        except (ParseError, ValidationError, ValueError) as exc:
            last_err = str(exc)
            if i == 0:
                messages = [
                    *messages,
                    {"role": "assistant", "content": res.text[-6000:] or "(empty)"},
                    _repair_message(spec, last_err),
                ]
            continue
        step.reasoning = "\n\n".join(reasoning_parts)[-8000:] or None
        dumped = out.model_dump(mode="json")
        step.plain = str(dumped.get("plain") or "")
        if spec.kind == "code":
            step.code = dumped.get("code")
            step.output = {"plain": step.plain}
        else:
            step.output = dumped
        step.duration_s = clock() - t0
        if observer is not None:
            observer.step_finished(exp_id, step)
        return RoleCall(out, step, results)
    step.status = "error"
    step.error = last_err[-2000:]
    step.reasoning = "\n\n".join(reasoning_parts)[-8000:] or None
    step.plain = f"{spec.name} could not produce a usable answer"
    step.duration_s = clock() - t0
    if observer is not None:
        observer.step_finished(exp_id, step)
    raise RoleFailed(f"{spec.name} failed: {last_err}", step) from last_exc
