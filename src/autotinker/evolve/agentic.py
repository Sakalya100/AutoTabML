"""The agentic loop (docs/AGENTIC_PLAN.md §3): a deterministic state machine that calls LLM agents at stages.

  PROFILE -> BASELINE (starter, e000) -> DRAFTS (N diverse families) -> IMPROVE (one atomic hypothesis per
  experiment; every K experiments an ablation of the best pipeline's blocks; TUNE when a family stalls)
  -> ENSEMBLE top-k kept -> stop rule (ceiling / budgets / token cap) -> LOCKED TEST once -> REPORT

(INTAKE runs before the harness exists, see `run_intake`; its step is attached to the run record.)

The LLMs decide *what to try*; code decides *what counts*: the frozen harness, the statistical gate and the
stop rule are reused unchanged. The Critic's leakage verdict (plus an autoevals second opinion on a different
provider) is an extra hard gate in front of a keep.

One experiment = one ball position: planner -> coder -> executor (-> debugger <= 5) -> critic (-> judge)
-> gate. A tuning phase (many Optuna trials) and the ensemble are one experiment each.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast, get_args

import pandas as pd

from autotinker.agent import evals
from autotinker.agent.llm import is_fatal_llm_error
from autotinker.agent.roles import specs
from autotinker.agent.roles.base import RoleFailed, run_role
from autotinker.agent.roles.schemas import (
    CodeOut,
    CriticOut,
    EnsemblerOut,
    IntakeOut,
    PlanOut,
    ProfilerOut,
    ReporterOut,
    TunerOut,
)
from autotinker.agent.router import ChatBackend
from autotinker.contracts import (
    AgentStep,
    Decision,
    ExecResult,
    HarnessProtocol,
    HpoTrial,
    Idea,
    IdeaCategory,
    LLMPurpose,
    LLMUsage,
    Metric,
    ProblemType,
    TaskSpec,
)
from autotinker.evolve import codegen
from autotinker.evolve.control import ControlChannel
from autotinker.evolve.gate import Candidate, Gate, StatGate
from autotinker.evolve.loop import _Best, _Runner, count_loc, unified_diff
from autotinker.evolve.stopping import HistoryPoint, StopDecision, StopRule
from autotinker.obs.events import (
    AgentReasoning,
    AgentStepFinished,
    AgentStepStarted,
    DecisionMade,
    ExperimentScored,
    ExperimentStarted,
    HpoTrialEvent,
    ReportReady,
    SandboxLog,
    SteerApplied,
)
from autotinker.obs.record import ExperimentRecord, RunRecord

Phase = Literal["baseline", "draft", "improve", "tune", "ensemble"]
_PURPOSES = set(get_args(LLMPurpose))


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class AgenticConfig:
    max_experiments: int = 10
    max_time_s: float = 40 * 60
    max_tokens: int = 400_000  # total tokens in + out across all agent calls
    max_cost_usd: float = 0.50  # actual cost ($0 on free tiers)
    min_experiments: int = 6  # the ceiling rule may fire from here on
    n_drafts: int = 3
    max_debug: int = 5
    ablation_every: int = 5
    stall_for_tune: int = 2  # non-keeps in a row on the best's family -> TUNE
    tune_trials: int = 20
    tune_budget_s: float = 150.0
    ensemble_top_k: int = 3
    critic: bool = True
    judge: bool = True
    # Critic vs second-opinion judge disagree: "note" keeps the gate's decision and flags it (the Critic
    # and the static checks remain hard gates); "discard" throws the result away. A weak judge produced
    # false "leak" calls in live runs, so flagging is the default.
    judge_disagreement: Literal["discard", "note"] = "note"
    max_consecutive_failures: int = 3


class _AgenticProposer:
    """The base runner wants a Proposer; in the agentic loop the roles replace it."""

    def __init__(self, label: str) -> None:
        self.label = label

    def draft(self, ctx: Any) -> Any:  # pragma: no cover - never called
        raise NotImplementedError

    def propose_and_implement(self, ctx: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    def repair(self, ctx: Any, code: str, error_tail: str) -> Any:  # pragma: no cover
        raise NotImplementedError


@dataclass
class _Exp:
    """Working state of one experiment while it runs."""

    exp_id: str
    phase: Phase
    steps: list[AgentStep] = field(default_factory=list)
    trials: list[HpoTrial] = field(default_factory=list)
    family: str = "other"


# ---------------------------------------------------------------- intake (before the harness exists)


def preview_csv(df: pd.DataFrame, max_rows: int = 50, max_chars: int = 9000) -> str:
    n = min(max_rows, len(df))
    while n > 3:
        text = df.head(n).to_csv(index=False)
        if len(text) <= max_chars:
            return text
        n = int(n * 0.7)
    return df.head(max(n, 1)).to_csv(index=False)[:max_chars]


def columns_summary(df: pd.DataFrame) -> str:
    lines = []
    for c in df.columns[:80]:
        s = df[c]
        lines.append(f"- {c}: dtype={s.dtype} unique={s.nunique(dropna=True)} missing={s.isna().mean():.0%}")
    return "\n".join(lines)


_METRICS_FOR = {
    "binary": {"roc_auc", "log_loss", "accuracy", "f1_macro"},
    "multiclass": {"log_loss", "accuracy", "f1_macro"},
    "regression": {"rmse", "mae", "r2"},
}


@dataclass
class IntakeDecision:
    target: str
    problem_type: ProblemType | None
    metric: Metric | None
    goal: str
    warnings: list[str]
    step: AgentStep | None


def _row_modes(backend: ChatBackend) -> tuple[bool, ...]:
    """(True, False): try a prompt with data rows, then schema-only. Schema-only at once when the backend
    may not send rows at all (Router.send_rows is False under AUTOTINKER_NO_ROWS)."""
    return (True, False) if getattr(backend, "send_rows", True) else (False,)


def run_intake(
    backend: ChatBackend | None,
    df: pd.DataFrame,
    *,
    goal: str = "",
    target: str | None = None,
    metric: str | None = None,
) -> IntakeDecision:
    """Ask the Intake agent for target / problem type / metric. User-given values always win; agent values
    are validated against the columns and the problem type; with no usable answer the profiler's defaults
    apply (the target then must be given)."""
    out: IntakeOut | None = None
    step: AgentStep | None = None
    if backend is not None:
        # With rows first (row-safe providers only); if none can serve, retry schema-only so any provider can.
        for rows in _row_modes(backend):
            try:
                call = run_role(
                    backend,
                    specs.INTAKE,
                    specs.intake_input(preview_csv(df) if rows else "", columns_summary(df), goal, target),
                    privacy=rows,  # the preview holds data rows
                    input_summary=f"{'preview' if rows else 'schema'} of {len(df.columns)} columns; "
                    f"user: {goal[:120] or '(none)'}",
                )
                out, step = call.output, call.step
                break
            except RoleFailed as exc:
                step = exc.step
                if is_fatal_llm_error(exc):
                    raise
    tgt = target
    if tgt is None and out is not None and out.target in df.columns:
        tgt = out.target
    if tgt is None:
        raise ValueError(
            "could not infer the target column; pass --target. Columns: " + ", ".join(map(str, df.columns))
        )
    ptype: ProblemType | None = None
    met: Metric | None = Metric(metric) if metric else None
    if out is not None and out.target == tgt:
        ptype = ProblemType(out.problem_type)
        if met is None and out.metric in _METRICS_FOR[out.problem_type]:
            met = Metric(out.metric)
    # The profiler re-infers the problem type from the data; a binary/multiclass mismatch would make the
    # chosen metric invalid, so only the metric is passed on and only if it fits the inferred type.
    from autotinker.data.profiler import infer_problem_type

    inferred = infer_problem_type(df[tgt].dropna())
    if met is not None and met.value not in _METRICS_FOR[inferred.value]:
        met = None
    return IntakeDecision(
        target=tgt,
        problem_type=ptype,
        metric=met,
        goal=(out.goal if out and out.goal else goal),
        warnings=list(out.warnings) if out else [],
        step=step,
    )


# ---------------------------------------------------------------- the runner


class AgenticRunner(_Runner):
    def __init__(
        self,
        harness: HarnessProtocol,
        backend: ChatBackend,
        *,
        cfg: AgenticConfig | None = None,
        goal: str = "",
        intake: IntakeDecision | None = None,
        gate: Gate | None = None,
        run_dir: Path | None = None,
        run_id: str | None = None,
        task: TaskSpec | None = None,
        starter_code: str | None = None,
        contract_doc: str | None = None,
        on_event: Callable[[Any], None] | None = None,
        events_stdout: bool = False,
        config: dict[str, Any] | None = None,
        control: ControlChannel | None = None,
    ) -> None:
        self.cfg = cfg or AgenticConfig()
        self.backend = backend
        providers = getattr(backend, "provider_names", None) or [type(backend).__name__]
        label = "agentic:" + "+".join(providers)
        cfg_dict = {
            "mode": "agentic",
            "proposer": label,
            "agentic": asdict(self.cfg),
            "providers": providers,
            "aliases": {r.name: r.alias for r in specs.ROLES.values()},
            **(config or {}),
        }
        super().__init__(
            harness,
            _AgenticProposer(label),
            mode="agentic",
            run_dir=run_dir,
            run_id=run_id,
            task=task,
            description=goal,
            starter_code=starter_code,
            contract_doc=contract_doc,
            allowed_imports=None,
            max_repairs=self.cfg.max_debug,
            on_event=on_event,
            events_stdout=events_stdout,
            config=cfg_dict,
        )
        if contract_doc is None:
            try:
                from autotinker.harness.contract import contract_doc as _cd

                self.contract_doc = _cd(self.allowed or None)
            except Exception:
                pass
        self.goal = goal
        self.intake = intake
        self.gate: Gate = gate or StatGate(test_train_ratio=1.0 / max(self.task.cv_folds - 1, 1))
        self.stop_rule = StopRule(
            min_experiments=self.cfg.min_experiments,
            max_experiments=self.cfg.max_experiments,
            max_cost_usd=self.cfg.max_cost_usd,
            max_time_s=self.cfg.max_time_s,
        )
        self.record.config["stop_rule"] = dict(vars(self.stop_rule))
        self.risks: list[str] = []
        self.drop_columns: list[str] = []
        self.families: dict[str, str] = {}  # exp_id -> family
        self.tuned_families: set[str] = set()
        self.ablation_text = ""
        self.last_ablation_at = 0
        self.ensembled = False
        self.failures = 0
        self.notes: list[str] = []  # plain-language notes for the chat/report (judge disagreements, ...)
        self.judge_stats = {"calls": 0, "agree": 0, "disagree": 0, "unavailable": 0}
        self._cur: _Exp | None = None
        self._pending: dict[str, list[AgentStep]] = {}
        self._usages: list[LLMUsage] = []
        self._t_exp = time.perf_counter()
        self._started_at = ""
        self.control = control
        self.user_constraints: list[str] = []
        self._user_stop = False

    # -------------------------------------------------- observer + accounting

    def _target_steps(self, exp_id: str | None) -> list[AgentStep]:
        if exp_id is None:
            return self.record.steps
        if self._cur is not None and self._cur.exp_id == exp_id:
            return self._cur.steps
        return self._pending.setdefault(exp_id, [])  # e.g. an ablation that precedes its experiment

    def step_started(self, exp_id: str | None, step: AgentStep) -> None:
        self._poll_control()
        self.emitter.emit(
            AgentStepStarted(
                run_id=self.run_id,
                exp_id=exp_id,
                step_id=step.step_id,
                role=step.role,
                attempt=step.attempt,
                input_summary=step.input_summary,
            )
        )

    def step_reasoning(self, exp_id: str | None, step: AgentStep, text: str) -> None:
        self.emitter.emit(
            AgentReasoning(
                run_id=self.run_id, exp_id=exp_id, step_id=step.step_id, role=step.role, text=text[-4000:]
            )
        )

    def step_finished(self, exp_id: str | None, step: AgentStep) -> None:
        self._account_step(step, exp_id)
        self._target_steps(exp_id).append(step)
        self.emitter.emit(AgentStepFinished(run_id=self.run_id, exp_id=exp_id, step=step))

    def _account_step(self, step: AgentStep, exp_id: str | None) -> None:
        if not step.model:
            return
        purpose = cast(LLMPurpose, step.role if step.role in _PURPOSES else "propose")
        usage = LLMUsage(
            purpose=purpose,
            model=f"{step.provider}/{step.model}" if step.provider else step.model,
            input_tokens=step.tokens_in,
            output_tokens=step.tokens_out,
            cost_usd=step.cost_usd,
            latency_s=step.duration_s,
        )
        self._account([usage], exp_id)
        if self._cur is not None and exp_id == self._cur.exp_id:
            self._usages.append(usage)

    def _emit_step(self, exp_id: str | None, step: AgentStep) -> None:
        """A deterministic (non-LLM) step: started + finished at once."""
        if not step.step_id:
            step.step_id = uuid.uuid4().hex[:10]
        if not step.started_at:
            step.started_at = _now()
        self.step_started(exp_id, step)
        self.step_finished(exp_id, step)

    def _sandbox_log(self, exp_id: str, attempt: int, text: str | None, stream: str = "stdout") -> None:
        if not text:
            return
        lines = text.splitlines()[-80:]
        for i in range(0, len(lines), 40):  # throttled: <= 2 events of <= 40 lines per attempt
            self.emitter.emit(
                SandboxLog(
                    run_id=self.run_id,
                    exp_id=exp_id,
                    attempt=attempt,
                    stream="stderr" if stream == "stderr" else "stdout",
                    lines=lines[i : i + 40],
                )
            )

    # -------------------------------------------------- live control (steer / stop)

    MAX_CONSTRAINTS = 10

    def _next_planned_exp(self) -> str:
        n = len(self.record.experiments)
        return f"e{n + (1 if self._cur is not None else 0):03d}"

    def _poll_control(self) -> None:
        """Apply queued steering/stop commands. Main thread only (it emits events)."""
        if self.control is None:
            return
        for cmd in self.control.drain():
            if cmd.type == "stop":
                self._user_stop = True
                continue
            text = cmd.text.strip()
            if not text:
                continue
            self.user_constraints.append(text)
            del self.user_constraints[: -self.MAX_CONSTRAINTS]
            self.notes.append(f"User asked: {text}")
            self.emitter.emit(SteerApplied(run_id=self.run_id, text=text, at_exp=self._next_planned_exp()))
        if self.control.stop_requested:
            self._user_stop = True

    @property
    def total_tokens(self) -> int:
        return self.record.total_input_tokens + self.record.total_output_tokens

    # -------------------------------------------------- helpers

    def _role(self, spec: Any, user: str, exp_id: str | None, **kw: Any) -> Any:
        return run_role(self.backend, spec, user, exp_id=exp_id, observer=self, **kw)

    def _best_cv_text(self) -> str:
        b = self.best
        if b is None or b.result.cv is None:
            return "not scored yet"
        return f"dev CV {b.result.cv.mean:.5f} ± {b.result.cv.se:.5f} (oriented)"

    def _families_tried(self) -> list[str]:
        return sorted(set(self.families.values()))

    def _kept(self) -> list[ExperimentRecord]:
        recs = [r for r in self.record.experiments if r.status == Decision.keep and r.cv is not None]
        return sorted(recs, key=lambda r: -(r.cv.mean if r.cv else 0.0))

    def _ensemble_pool(self) -> list[ExperimentRecord]:
        """Ensemble candidates: the best, then other valid scored solutions (kept, or discarded by the gate
        only for not being *significantly* better; never anything the audit flagged), best CV first."""
        ok = [
            r
            for r in self.record.experiments
            if r.cv is not None
            and r.phase != "ensemble"
            and (
                r.status == Decision.keep
                or (r.status == Decision.discard and not r.reason.startswith(("critic", "audit")))
            )
        ]
        best_id = self.best.exp_id if self.best else None
        ok.sort(key=lambda r: (r.id != best_id, -(r.cv.mean if r.cv else 0.0)))
        out: list[ExperimentRecord] = []
        seen_codes: set[str] = set()
        for r in ok:
            if r.code.strip() in seen_codes:
                continue
            seen_codes.add(r.code.strip())
            out.append(r)
        return out

    def _execute(self, exp: _Exp, code: str, attempt: int) -> ExecResult:
        res = self._evaluate(code, exp.exp_id, attempt)
        last = (res.error_tail or "").strip().splitlines()[-1:] or [res.error_kind or "error"]
        plain = (
            # Shown to the user: the metric's natural value (log-loss positive), never the oriented one.
            f"Ran in the sandbox: CV {self.record.profile.metric.to_raw(res.cv.mean):.4f} ± {res.cv.se:.4f}"
            if res.ok and res.cv
            else f"Crashed in the sandbox: {last[0][:160]}"
        )
        self._emit_step(
            exp.exp_id,
            AgentStep(
                role="executor",
                attempt=attempt,
                status="ok" if res.ok else "error",
                plain=plain,
                input_summary=f"solution.py ({count_loc(code)} lines)",
                code=code,
                stdout_tail=res.stdout_tail,
                stderr_tail=res.error_tail,
                error=None if res.ok else res.error_kind,
                duration_s=res.duration_s,
                output={"cv_mean": res.cv.mean, "cv_se": res.cv.se, "select": res.select_score}
                if res.ok and res.cv
                else None,
            ),
        )
        self._sandbox_log(exp.exp_id, attempt, res.stdout_tail)
        if not res.ok:
            self._sandbox_log(exp.exp_id, attempt, res.error_tail, "stderr")
        return res

    # -------------------------------------------------- experiment

    def _start(self, exp_id: str, phase: Phase) -> _Exp:
        self._cur = _Exp(exp_id, phase, steps=self._pending.pop(exp_id, []))
        self._usages = []
        self._t_exp = time.perf_counter()
        self._started_at = _now()
        return self._cur

    def _run(self, exp: _Exp, idea: Idea, code: str, *, debug: bool = True) -> ExperimentRecord:
        parent = self.best
        parent_id = parent.exp_id if parent else None
        self.emitter.emit(
            ExperimentStarted(
                run_id=self.run_id, exp_id=exp.exp_id, parent_id=parent_id, idea=idea, phase=exp.phase
            )
        )
        res = self._execute(exp, code, 0)
        attempts = 0
        while not res.ok and debug and attempts < self.cfg.max_debug:
            attempts += 1
            try:
                call = self._role(
                    specs.DEBUGGER,
                    specs.debugger_input(
                        contract=self.contract_doc,
                        title=idea.title,
                        code=code,
                        error=res.error_tail or res.error_kind or "",
                        profile=self.h.profile,
                    ),
                    exp.exp_id,
                    attempt=attempts,
                    input_summary=f"fix attempt {attempts}: {(res.error_tail or '').strip()[-160:]}",
                )
            except RoleFailed as exc:
                if is_fatal_llm_error(exc):
                    raise
                break
            out = cast(CodeOut, call.output)
            code = out.code
            res = self._execute(exp, code, attempts)
        loc = count_loc(code)
        decision: Decision
        if not res.ok:
            decision = Decision.crash
            reason = f"{res.error_kind or 'error'} after {attempts} debug attempt(s)"
            if attempts >= self.cfg.max_debug:
                reason += " (idea abandoned)"
        else:
            assert res.cv is not None
            self.emitter.emit(
                ExperimentScored(
                    run_id=self.run_id,
                    exp_id=exp.exp_id,
                    cv=res.cv,
                    select_score=res.select_score if res.select_score is not None else res.cv.mean,
                    fit_time_s=res.fit_time_s or 0.0,
                    loc=loc,
                )
            )
            if parent is None:
                decision, reason = Decision.keep, "baseline"
            else:
                decision, reason = self.gate(Candidate(res, loc), Candidate(parent.result, parent.loc))
                decision, reason = self._audit(exp, idea, code, parent, res, decision, reason)
        return self._finalize(exp, idea, code, parent, res, decision, reason, attempts)

    def _audit(
        self,
        exp: _Exp,
        idea: Idea,
        code: str,
        parent: _Best,
        res: ExecResult,
        decision: Decision,
        reason: str,
    ) -> tuple[Decision, str]:
        """Critic (every scored experiment) + judge (only when the gate would keep)."""
        if not self.cfg.critic:
            return decision, reason
        assert res.cv is not None and parent.result.cv is not None
        gain = res.cv.mean - parent.result.cv.mean
        se = max(parent.result.cv.se, 1e-12)
        scan = codegen.leakage_scan(code, self.h.profile)
        if gain > 10 * se and gain > 0.02:
            scan.append(f"suspiciously large jump: +{gain:.4g} ({gain / se:.0f} SE)")
        diff = unified_diff(parent.code, code, parent.exp_id, exp.exp_id)
        scores = (
            f"candidate CV {res.cv.mean:.5f}±{res.cv.se:.5f}, parent {parent.exp_id} CV "
            f"{parent.result.cv.mean:.5f}±{parent.result.cv.se:.5f}; gate: {decision.value} ({reason[:200]})"
        )
        try:
            call = self._role(
                specs.CRITIC,
                specs.critic_input(
                    profile=self.h.profile, title=idea.title, diff=diff, scores=scores, scan=scan
                ),
                exp.exp_id,
                input_summary=f"audit {exp.exp_id}: gain {gain:+.4g}; scan: {len(scan)} finding(s)",
            )
        except RoleFailed as exc:
            if is_fatal_llm_error(exc):
                raise
            self.notes.append(f"{exp.exp_id}: critic unavailable; gate decision stands")
            return decision, reason
        crit = cast(CriticOut, call.output)
        if crit.verdict == "leak":
            return (
                Decision.discard,
                f"critic: leak ({crit.reasons[:200]}); gate said {decision.value}: {reason}",
            )
        if decision != Decision.keep or not self.cfg.judge:
            return decision, reason
        judge = evals.second_opinion(
            self.backend,
            code_excerpt=specs.excerpt(code, 5000),
            context=specs.profile_text(self.h.profile, rows=False, max_cols=30) + "\n" + scores,
            critic_verdict=crit.verdict,
            critic_provider=call.step.provider,
        )
        self.judge_stats["calls"] += 1
        self._emit_step(exp.exp_id, judge.step)
        if judge.verdict is None:
            self.judge_stats["unavailable"] += 1
            return decision, reason
        if judge.verdict == crit.verdict:
            self.judge_stats["agree"] += 1
            return decision, reason
        self.judge_stats["disagree"] += 1
        note = f"{exp.exp_id}: critic said {crit.verdict}, judge said {judge.verdict}"
        self.notes.append(note)
        if self.cfg.judge_disagreement == "discard":
            return Decision.discard, f"audit disagreement ({note}); gate said keep: {reason}"
        return decision, reason + f"; flagged for review: {note}"

    def _finalize(
        self,
        exp: _Exp,
        idea: Idea,
        code: str,
        parent: _Best | None,
        res: ExecResult,
        decision: Decision,
        reason: str,
        attempts: int,
    ) -> ExperimentRecord:
        loc = count_loc(code)
        prev_mean = parent.result.cv.mean if parent and parent.result.cv else None
        if decision == Decision.keep:
            self.best = _Best(exp.exp_id, code, res, loc)
            self.since_last_keep = 0
        else:
            self.since_last_keep += 1
        self.families[exp.exp_id] = exp.family
        best = self.best
        self.emitter.emit(
            DecisionMade(
                run_id=self.run_id,
                exp_id=exp.exp_id,
                decision=decision,
                reason=reason[:2000],
                best_exp_id=best.exp_id if best else exp.exp_id,
                best_cv_mean=best.result.cv.mean if best and best.result.cv else 0.0,
            )
        )
        rec = ExperimentRecord(
            id=exp.exp_id,
            parent_id=parent.exp_id if parent else None,
            idea=idea,
            code=code,
            diff=unified_diff(
                parent.code if parent else self.starter,
                code,
                parent.exp_id if parent else "starter",
                exp.exp_id,
            ),
            status=decision,
            reason=reason[:2000],
            cv=res.cv,
            select_score=res.select_score,
            fit_time_s=res.fit_time_s,
            loc=loc,
            repair_attempts=attempts,
            error_kind=res.error_kind,
            error_tail=res.error_tail,
            llm_calls=list(self._usages),
            cost_usd=sum(u.cost_usd for u in self._usages),
            duration_s=time.perf_counter() - self._t_exp,
            started_at=self._started_at,
            phase=exp.phase,
            steps=list(exp.steps),
            trials=list(exp.trials),
        )
        self.ledger.append(rec)
        self.record.experiments.append(rec)
        if self.best is not None and self.best.result.cv is not None:
            gain = None
            if decision == Decision.keep and prev_mean is not None:
                gain = self.best.result.cv.mean - prev_mean
            self.history.append(
                HistoryPoint(
                    exp_id=exp.exp_id,
                    status=decision.value,
                    radical=idea.radical,
                    best_mean=self.best.result.cv.mean,
                    best_se=self.best.result.cv.se,
                    keep_gain=gain,
                )
            )
        self._cur = None
        self._sync_usage()
        self.save()
        return rec

    def _fail(self, exp: _Exp, exc: Exception) -> None:
        """Planner/Coder/Tuner/Ensembler could not produce anything runnable: a crashed experiment."""
        self.failures += 1
        parent = self.best
        idea = Idea(title="(agent failed)", rationale=str(exc)[:500], category=IdeaCategory.repair)
        self.emitter.emit(
            ExperimentStarted(
                run_id=self.run_id,
                exp_id=exp.exp_id,
                parent_id=parent.exp_id if parent else None,
                idea=idea,
                phase=exp.phase,
            )
        )
        res = ExecResult(ok=False, error_kind="runtime", error_tail=str(exc)[-2000:])
        self._finalize(exp, idea, "", parent, res, Decision.crash, f"agent failed: {exc}"[:1000], 0)

    def _sync_usage(self) -> None:
        summary = getattr(self.backend, "usage_summary", None)
        if callable(summary):
            self.record.usage = summary()
        self.record.usage["judge"] = dict(self.judge_stats)
        self.record.usage["notes"] = list(self.notes[-50:])

    # -------------------------------------------------- stages

    def profile_stage(self) -> None:
        names = {c.name for c in self.h.profile.columns}
        # Deterministic safety net: columns the code-computed profile flags as IDs are always excluded, even
        # if no LLM answers (seen live: with the row-safe provider down, the baseline kept an `Id` column).
        flagged = [c.name for c in self.h.profile.columns if "id_like" in c.flags]
        self.drop_columns = flagged
        out: ProfilerOut | None = None
        # With sample rows first (row-safe providers only); if none can serve, retry schema-only.
        for rows in _row_modes(self.backend):
            try:
                call = self._role(
                    specs.PROFILER,
                    specs.profiler_input(self.h.profile, self.goal, rows=rows),
                    None,
                    privacy=rows,  # sample rows
                    input_summary=f"profile{'' if rows else ' (schema only)'}: "
                    f"{self.h.profile.n_rows} rows x {len(self.h.profile.columns)} cols",
                )
                out = cast(ProfilerOut, call.output)
                break
            except RoleFailed as exc:
                if is_fatal_llm_error(exc):
                    raise
        if out is None:
            return
        self.risks = out.risks[:8]
        self.drop_columns = sorted({*flagged, *(c for c in out.drop_columns if c in names)})

    def baseline(self) -> None:
        exp = self._start("e000", "baseline")
        exp.family = "gradient_boosting"
        if self.drop_columns:
            idea = Idea(
                title=f"Baseline: starter solution without {', '.join(self.drop_columns)}",
                rationale="the Profiler ruled these columns out (IDs / leakage)",
                category=IdeaCategory.baseline,
            )
            code = codegen.without_columns(self.starter, self.drop_columns)
        else:
            idea = Idea(title="Baseline: unmodified starter solution", category=IdeaCategory.baseline)
            code = self.starter
        self._run(exp, idea, code, debug=False)

    def _plan(self, exp: _Exp, phase: Phase) -> PlanOut:
        if phase == "draft":
            instruction = (
                "DRAFT: propose a complete solution from a model family NOT in the list of families tried "
                "(write it from the starter, not as a tweak of the best). Set radical=true."
            )
            base_code, base_id = self.starter, "starter"
        else:
            instruction = "IMPROVE: propose ONE atomic change to the current best (one block). " + (
                f"The last {self.since_last_keep} experiments were not kept; consider a bolder change."
                if self.since_last_keep >= 3
                else ""
            )
            base_code = self.best.code if self.best else self.starter
            base_id = self.best.exp_id if self.best else "starter"
        call = self._role(
            specs.PLANNER,
            specs.planner_input(
                profile=self.h.profile,
                goal=self.goal,
                risks=self.risks,
                drop_columns=self.drop_columns,
                phase=phase,
                ledger=self.ledger.summary(max_lines=15),
                best_id=base_id,
                best_code=base_code,
                best_cv=self._best_cv_text(),
                families_tried=self._families_tried(),
                ablation=self.ablation_text if phase == "improve" else "",
                instruction=instruction,
                constraints=self.user_constraints,
            ),
            exp.exp_id,
            input_summary=f"{phase}: {len(self.record.experiments)} done, {self._best_cv_text()}",
        )
        return cast(PlanOut, call.output)

    def _code(self, exp: _Exp, plan: PlanOut, base_id: str, base_code: str) -> str:
        call = self._role(
            specs.CODER,
            specs.coder_input(
                contract=self.contract_doc,
                profile=self.h.profile,
                title=plan.title,
                rationale=plan.rationale,
                base_id=base_id,
                base_code=base_code,
                drop_columns=self.drop_columns,
            ),
            exp.exp_id,
            input_summary=f"implement: {plan.title[:160]} (on {base_id})",
        )
        out = cast(CodeOut, call.output)
        call.step.diff = unified_diff(base_code, out.code, base_id, exp.exp_id)
        return out.code

    def plan_and_code(self, exp_id: str, phase: Phase) -> None:
        exp = self._start(exp_id, phase)
        try:
            plan = self._plan(exp, phase)
            exp.family = plan.family
            if phase == "draft":
                base_id, base_code = "starter", self.starter
            else:
                assert self.best is not None
                base_id, base_code = self.best.exp_id, self.best.code
            code = self._code(exp, plan, base_id, base_code)
        except RoleFailed as exc:
            if is_fatal_llm_error(exc):
                raise
            self._fail(exp, exc)
            return
        self.failures = 0
        idea = Idea(
            title=plan.title,
            rationale=plan.rationale,
            category=plan.category,
            radical=plan.radical or phase == "draft",
        )
        self._run(exp, idea, code)

    def ablation(self, exp_id: str) -> None:
        """Switch off each named block of the best pipeline and re-score it (no LLM, not an experiment)."""
        best = self.best
        if best is None or best.result.cv is None:
            return
        variants = codegen.ablation_variants(best.code)
        if not variants:
            return
        t0 = time.perf_counter()
        rows: list[tuple[str, float | None, str]] = []
        for name, code in variants:
            res = self.h.evaluate(code, f"{exp_id}-ablate-{name}")
            if res.ok and res.cv is not None:
                rows.append((name, res.cv.mean - best.result.cv.mean, ""))
            else:
                rows.append((name, None, res.error_kind or "error"))
        scored = sorted((r for r in rows if r[1] is not None), key=lambda r: -abs(r[1] or 0.0))
        lines = [
            f"- removing '{n}': {d:+.5f} CV ({'it helps' if (d or 0) < 0 else 'it does not help'})"
            for n, d, _ in scored
        ]
        lines += [f"- removing '{n}': could not run ({e})" for n, d, e in rows if d is None]
        se = best.result.cv.se
        top = scored[0][0] if scored else None
        self.ablation_text = (
            "\n".join(lines)
            + f"\n(best CV SE = {se:.5f}; the block with the largest effect is "
            + f"'{top}' - target it or the model.)"
            if top
            else "\n".join(lines)
        )
        self.last_ablation_at = len(self.record.experiments)
        self._emit_step(
            exp_id,
            AgentStep(
                role="ablation",
                plain=(
                    f"Ablation of {best.exp_id}: the block that matters most is '{top}'."
                    if top
                    else f"Ablation of {best.exp_id}: no block could be removed cleanly."
                ),
                input_summary=f"switch off each of {len(variants)} blocks of {best.exp_id}",
                output={"best": best.exp_id, "deltas": {n: d for n, d, _ in rows}},
                duration_s=time.perf_counter() - t0,
            ),
        )

    def tune(self, exp_id: str) -> None:
        best = self.best
        assert best is not None and best.result.cv is not None
        exp = self._start(exp_id, "tune")
        family = self.families.get(best.exp_id, "other")
        exp.family = family
        self.tuned_families.add(family)
        remaining = max(self.cfg.max_time_s - self.elapsed, 60.0)
        budget = min(self.cfg.tune_budget_s, remaining * 0.4)
        try:
            call = self._role(
                specs.TUNER,
                specs.tuner_input(
                    profile=self.h.profile,
                    code=best.code,
                    cv=self._best_cv_text(),
                    budget_s=budget,
                    constraints=self.user_constraints,
                ),
                exp_id,
                input_summary=f"search space for {best.exp_id} ({family})",
            )
        except RoleFailed as exc:
            if is_fatal_llm_error(exc):
                raise
            self._fail(exp, exc)
            return
        out = cast(TunerOut, call.output)
        tune_fn = getattr(self.h, "tune", None)
        idea = Idea(
            title=f"Tune {family} hyperparameters ({', '.join(out.params)})"[:200],
            rationale=out.rationale,
            category=IdeaCategory.hyperparameters,
        )
        if not callable(tune_fn):
            self._fail(exp, RuntimeError("this harness cannot run hyperparameter searches"))
            return
        space = {k: v.model_dump() for k, v in out.params.items()}
        n_trials = max(4, min(out.n_trials, self.cfg.tune_trials))
        t0 = time.perf_counter()
        tr = tune_fn(best.code, space, n_trials=n_trials, time_budget_s=budget, label=f"{exp_id}-tune")
        exp.trials = list(tr.trials)
        for t in tr.trials:
            self.emitter.emit(HpoTrialEvent(run_id=self.run_id, exp_id=exp_id, trial=t))
        done = [t for t in tr.trials if t.value is not None]
        self._emit_step(
            exp_id,
            AgentStep(
                role="optuna",
                status="ok" if tr.ok else "error",
                plain=(
                    f"Optuna ran {len(tr.trials)} trials; best inner-CV {tr.best_value:.4f}."
                    if tr.ok and tr.best_value is not None
                    else "The hyperparameter search failed."
                ),
                input_summary=f"{n_trials} trials, {budget:.0f}s budget, {len(space)} parameters",
                output={"best_params": tr.best_params, "n_trials": len(tr.trials), "n_ok": len(done)},
                stdout_tail=tr.stdout_tail,
                stderr_tail=tr.error_tail,
                error=tr.error_kind,
                duration_s=time.perf_counter() - t0,
            ),
        )
        if not tr.ok:
            self._fail(exp, RuntimeError(f"tuning failed: {tr.error_kind}: {(tr.error_tail or '')[-400:]}"))
            return
        self.failures = 0
        idea.title = f"Tune {family}: " + ", ".join(
            f"{k.split('__')[-1]}={v}" for k, v in tr.best_params.items()
        )
        idea.title = idea.title[:200]
        self._run(exp, idea, codegen.with_params(best.code, tr.best_params), debug=False)

    def ensemble(self, exp_id: str) -> None:
        self.ensembled = True
        kept = self._ensemble_pool()
        if len(kept) < 2:
            return
        exp = self._start(exp_id, "ensemble")
        exp.family = "ensemble"
        top = kept[: max(self.cfg.ensemble_top_k + 2, 4)]
        table = [
            {
                "id": r.id,
                "title": r.idea.title[:100],
                "family": self.families.get(r.id, "other"),
                "cv": r.cv.mean if r.cv else 0.0,
                "se": r.cv.se if r.cv else 0.0,
                "fit_time": f"{r.fit_time_s:.2f}s" if r.fit_time_s else "?",
            }
            for r in top
        ]
        by_id = {r.id: r for r in top}
        try:
            call = self._role(
                specs.ENSEMBLER,
                specs.ensembler_input(profile=self.h.profile, kept=table),
                exp_id,
                input_summary=f"choose members among {', '.join(by_id)}",
            )
            out = cast(EnsemblerOut, call.output)
            members = [m for m in dict.fromkeys(out.members) if m in by_id][: self.cfg.ensemble_top_k]
            strategy, weights = out.strategy, out.weights
        except RoleFailed as exc:
            if is_fatal_llm_error(exc):
                raise
            members, strategy, weights = [], "soft_vote", None
        if len(members) < 2:
            members = [r.id for r in top[: self.cfg.ensemble_top_k]]
            weights = None
        if weights is not None and len(weights) != len(members):
            weights = None
        code = codegen.ensemble_code(
            [(m, by_id[m].code) for m in members], strategy=strategy, weights=weights
        )
        idea = Idea(
            title=f"Ensemble ({strategy.replace('_', ' ')}) of {', '.join(members)}",
            rationale="combine diverse kept solutions",
            category=IdeaCategory.ensembling,
            radical=True,
        )
        self._run(exp, idea, code)

    # -------------------------------------------------- the state machine

    def _stop(self) -> StopDecision:
        n = len(self.record.experiments)
        if self._user_stop:
            last = self.record.experiments[-1].id if self.record.experiments else "the profile"
            return StopDecision(
                True, "user", self.stop_rule.signals(self.history), f"stopped by the user after {last}"
            )
        d = self.stop_rule.check(self.history, n_experiments=n, cost_usd=self.cost, elapsed_s=self.elapsed)
        if not d.stop and self.total_tokens >= self.cfg.max_tokens:
            return StopDecision(
                True,
                "max_tokens",
                d.report,
                f"token budget reached ({self.total_tokens} >= {self.cfg.max_tokens} tokens)",
            )
        return d

    def _next_action(self) -> str:
        n = len(self.record.experiments)
        kept = self._ensemble_pool()
        last_slot = n >= self.cfg.max_experiments - 1
        if last_slot and len(kept) >= 2 and not self.ensembled:
            return "ensemble"
        n_drafts_done = sum(1 for r in self.record.experiments if r.phase == "draft")
        if n_drafts_done < self.cfg.n_drafts:
            return "draft"
        best_family = self.families.get(self.best.exp_id, "other") if self.best else "other"
        if (
            self.since_last_keep >= self.cfg.stall_for_tune
            and best_family not in self.tuned_families
            and best_family != "ensemble"
            and callable(getattr(self.h, "tune", None))
        ):
            return "tune"
        return "improve"

    def run(self) -> RunRecord:
        self.emit_start()
        if self.intake is not None and self.intake.step is not None:
            self._emit_step(None, self.intake.step)
        decision = StopDecision(False, None)
        try:
            self.profile_stage()
            self.baseline()
            while True:
                self._poll_control()
                decision = self._stop()
                if decision.stop:
                    if (
                        decision.reason == "ceiling"
                        and not self.ensembled
                        and len(self._ensemble_pool()) >= 2
                    ):
                        self.ensemble(f"e{len(self.record.experiments):03d}")
                    break
                n = len(self.record.experiments)
                exp_id = f"e{n:03d}"
                action = self._next_action()
                if (
                    action == "improve"
                    and self.cfg.ablation_every > 0
                    and n - self.last_ablation_at >= self.cfg.ablation_every
                ):
                    self.ablation(exp_id)
                if action == "ensemble":
                    self.ensemble(exp_id)
                    if len(self.record.experiments) == n:  # nothing to ensemble
                        self.plan_and_code(exp_id, "improve")
                elif action == "tune":
                    self.tune(exp_id)
                else:
                    self.plan_and_code(exp_id, cast(Phase, action))
                if self.failures >= self.cfg.max_consecutive_failures:
                    decision = StopDecision(
                        True,
                        "proposer_failure",
                        self.stop_rule.signals(self.history),
                        f"aborted at {exp_id}: the agents failed {self.failures} times in a row",
                    )
                    break
        except KeyboardInterrupt:
            decision = StopDecision(True, "user", self.stop_rule.signals(self.history), "stopped by the user")
        except Exception as exc:
            if not is_fatal_llm_error(exc):
                raise
            decision = StopDecision(
                True,
                "proposer_failure",
                self.stop_rule.signals(self.history),
                f"aborted: no LLM provider is usable ({exc})",
            )
        self._sync_usage()
        return self.finish(decision)

    # -------------------------------------------------- report

    def _facts(self) -> dict[str, Any]:
        r = self.record
        m = r.profile.metric
        f = r.final
        exps = r.experiments
        facts: dict[str, Any] = {
            "metric": m.value,
            "metric_direction": "higher is better" if m.greater_is_better else "lower is better",
            "n_experiments": len(exps),
            "n_kept": sum(1 for e in exps if e.status == Decision.keep),
            "n_discarded": sum(1 for e in exps if e.status == Decision.discard),
            "n_crashed": sum(1 for e in exps if e.status == Decision.crash),
            "wall_time_min": round(r.wall_time_s / 60.0, 2),
            "total_tokens": r.total_input_tokens + r.total_output_tokens,
            "n_rows": r.profile.n_rows,
            "n_features": len(r.profile.columns),
        }
        base = next((e for e in exps if e.id == "e000" and e.cv is not None), None)
        if base is not None and base.cv is not None:
            facts["baseline_cv"] = round(m.to_raw(base.cv.mean), 6)
        if f is not None:
            facts.update(
                best_exp_id=f.best_exp_id,
                best_cv=round(m.to_raw(f.dev_cv_mean), 6),
                select_score=round(m.to_raw(f.select_score), 6),
                test_score=round(m.to_raw(f.test_score), 6),
                optimism_gap=round(f.optimism_gap, 6),
            )
            best = next((e for e in exps if e.id == f.best_exp_id), None)
            if best is not None:
                facts["best_idea"] = best.idea.title
                if best.cv is not None:
                    facts["best_cv_se"] = round(best.cv.se, 6)
        return facts

    def _before_close(self) -> None:
        self.emit_assets()
        facts = self._facts()
        lines = [
            f"{e.id} {e.status.value} [{e.phase or '-'}] {e.idea.title[:90]} "
            + (f"cv={self.record.profile.metric.to_raw(e.cv.mean):.5f}" if e.cv else f"({e.error_kind})")
            for e in self.record.experiments
        ]
        stop = (self.record.stop or {}).get("summary", "")
        report: dict[str, Any]
        try:
            call = self._role(
                specs.REPORTER,
                specs.reporter_input(facts=facts, experiments=lines, stop_summary=stop, goal=self.goal),
                None,
                input_summary=f"RunRecord facts ({len(facts)} keys) + {len(lines)} experiments",
            )
            out = cast(ReporterOut, call.output)
            report = out.model_dump(mode="json")
        except Exception as exc:  # the report is best-effort; a run never fails because of it
            print(f"[autotinker] reporter failed: {exc}", file=sys.stderr)
            report = {
                "summary": (
                    f"{facts['n_experiments']} experiments, {facts['n_kept']} kept. "
                    f"Best {facts.get('best_exp_id')}: "
                    f"CV {facts.get('best_cv')}, locked test {facts.get('test_score')} ({facts['metric']})."
                ),
                "what_worked": [],
                "caveats": ["the Reporter agent was unavailable; this summary was generated from the record"],
                "next_steps": [],
                "numbers": {},
                "plain": "The run finished; see the numbers above.",
            }
        numeric = {
            k: float(v) for k, v in facts.items() if isinstance(v, int | float) and not isinstance(v, bool)
        }
        checks = evals.check_numbers(report.get("numbers") or {}, numeric)
        corrected = []
        for c in checks:
            if not c.ok:
                report["numbers"][c.key] = c.actual
                corrected.append({"key": c.key, "quoted": c.quoted, "actual": c.actual, "score": c.score})
        report["facts"] = facts
        report["checks"] = {
            "numeric_diff": [asdict(c) for c in checks],
            "corrected": corrected,
            "faithful": not corrected,
        }
        report["notes"] = list(self.notes)
        self.record.report = report
        self._sync_usage()
        self.emitter.emit(ReportReady(run_id=self.run_id, report=report))
        self.save()
        if self.run_dir is not None:
            (self.run_dir / "report.json").write_text(
                json.dumps(report, indent=2, default=str), encoding="utf-8"
            )


def run_agentic(
    harness: HarnessProtocol,
    backend: ChatBackend,
    *,
    cfg: AgenticConfig | None = None,
    goal: str = "",
    intake: IntakeDecision | None = None,
    run_dir: Path | None = None,
    run_id: str | None = None,
    task: TaskSpec | None = None,
    starter_code: str | None = None,
    contract_doc: str | None = None,
    on_event: Callable[[Any], None] | None = None,
    events_stdout: bool = False,
    config: dict[str, Any] | None = None,
    control: ControlChannel | None = None,
) -> RunRecord:
    return AgenticRunner(
        harness,
        backend,
        cfg=cfg,
        goal=goal,
        intake=intake,
        run_dir=run_dir,
        run_id=run_id,
        task=task,
        starter_code=starter_code,
        contract_doc=contract_doc,
        on_event=on_event,
        events_stdout=events_stdout,
        config=config,
        control=control,
    ).run()
