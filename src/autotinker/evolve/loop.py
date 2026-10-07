"""The experiment loops (ROADMAP §1.4 and §3.1).

run_single: draft -> evaluate -> up to N repairs -> final                       (mode "run")
evolve:     baseline (starter, e000) -> hill-climb: propose+implement from the current best -> evaluate ->
            up to N repairs on crash -> gate -> log -> update best, until the stop rule fires  (mode "evolve")

Both finish by scoring the best solution on the locked test split exactly once and writing
run.json + events.jsonl + ledger.jsonl + best_solution.py into the run directory.
"""

from __future__ import annotations

import difflib
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from autotinker.agent.context import KeptSolution, Proposal, ProposalContext
from autotinker.agent.llm import is_fatal_llm_error
from autotinker.agent.proposer import ProposalFailed, Proposer
from autotinker.contracts import (
    Decision,
    ExecResult,
    HarnessProtocol,
    Idea,
    IdeaCategory,
    LLMUsage,
    TaskSpec,
)
from autotinker.evolve.gate import Candidate, Gate, StatGate
from autotinker.evolve.ledger import Ledger
from autotinker.evolve.stopping import HistoryPoint, StopDecision, StopReason, StopRule
from autotinker.obs import otel
from autotinker.obs.emitter import EventEmitter
from autotinker.obs.events import (
    DecisionMade,
    ExperimentScored,
    ExperimentStarted,
    LLMCall,
    RunFinished,
    RunStarted,
    SandboxFinished,
    Stopped,
)
from autotinker.obs.record import ExperimentRecord, FinalScores, RunRecord

FALLBACK_STARTER = '''"""Starter solution (fallback; the harness normally provides its own)."""
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OrdinalEncoder


def build_pipeline(profile):
    num = [c["name"] for c in profile["columns"] if c["kind"] == "numeric"]
    cat = [c["name"] for c in profile["columns"] if c["kind"] in ("categorical", "boolean", "text")]
    prep = ColumnTransformer([
        ("num", SimpleImputer(strategy="median"), num),
        ("cat", Pipeline([
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("encode", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)),
        ]), cat),
    ])
    if profile["problem_type"] == "regression":
        model = HistGradientBoostingRegressor(random_state=0)
    else:
        model = HistGradientBoostingClassifier(random_state=0)
    return Pipeline([("prep", prep), ("model", model)])
'''


def count_loc(code: str) -> int:
    """Lines of code, ignoring blanks and comment-only lines."""
    return sum(1 for ln in code.splitlines() if ln.strip() and not ln.strip().startswith("#"))


def unified_diff(parent: str, child: str, parent_id: str, child_id: str) -> str:
    return "".join(
        difflib.unified_diff(
            parent.splitlines(keepends=True),
            child.splitlines(keepends=True),
            fromfile=f"{parent_id}/solution.py",
            tofile=f"{child_id}/solution.py",
        )
    )


def new_run_id(stem: str = "run") -> str:
    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in stem)[:40] or "run"
    return f"{ts}-{safe}-{uuid.uuid4().hex[:6]}"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _harness_defaults() -> tuple[str | None, str | None]:
    try:
        from autotinker.harness.contract import CONTRACT_DOC, STARTER_SOLUTION

        return str(STARTER_SOLUTION), str(CONTRACT_DOC)
    except Exception:
        return None, None


@dataclass
class _Best:
    exp_id: str
    code: str
    result: ExecResult
    loc: int


@dataclass
class _Outcome:
    code: str
    result: ExecResult
    repairs: int
    usages: list[LLMUsage] = field(default_factory=list)


class _Runner:
    """Shared machinery: event emission, evaluation with repairs, record keeping."""

    def __init__(
        self,
        harness: HarnessProtocol,
        proposer: Proposer,
        *,
        mode: str,
        run_dir: Path | None,
        run_id: str | None,
        task: TaskSpec | None,
        description: str,
        starter_code: str | None,
        contract_doc: str | None,
        allowed_imports: frozenset[str] | None,
        max_repairs: int,
        on_event: Callable[[Any], None] | None,
        events_stdout: bool,
        config: dict[str, Any],
    ) -> None:
        self.h = harness
        self.proposer = proposer
        self.mode = mode
        self.run_id = run_id or new_run_id(mode)
        self.run_dir = run_dir
        if run_dir is not None:
            run_dir.mkdir(parents=True, exist_ok=True)
        h_starter, h_contract = _harness_defaults()
        self.starter = starter_code or h_starter or FALLBACK_STARTER
        self.contract_doc = contract_doc or h_contract or ""
        self.allowed = allowed_imports or frozenset(getattr(harness, "allowed_imports", frozenset()) or ())
        h_task = getattr(harness, "task", None)
        self.task: TaskSpec = task or (
            h_task if isinstance(h_task, TaskSpec) else TaskSpec(target=harness.profile.target)
        )
        self.description = description or self.task.description
        self.max_repairs = max_repairs
        self.emitter = EventEmitter(
            self.run_id,
            jsonl_path=run_dir / "events.jsonl" if run_dir else None,
            callbacks=[on_event] if on_event else [],
            stdout=events_stdout,
        )
        self.ledger = Ledger(run_dir / "ledger.jsonl" if run_dir else None)
        self.t0 = time.perf_counter()
        self.record = RunRecord(
            run_id=self.run_id,
            created_at=_now(),
            mode=mode,
            proposer=proposer.label,
            task=self.task,
            profile=harness.profile,
            config=config,
        )
        self.best: _Best | None = None
        self.history: list[HistoryPoint] = []
        self.since_last_keep = 0

    # ------------------------------------------------------------ helpers

    @property
    def cost(self) -> float:
        return self.record.total_cost_usd

    @property
    def elapsed(self) -> float:
        return time.perf_counter() - self.t0

    def emit_start(self) -> None:
        self.emitter.emit(
            RunStarted(
                run_id=self.run_id,
                task=self.task,
                profile=self.h.profile,
                config=self.record.config,
                proposer=self.proposer.label,
            )
        )

    def _account(self, usages: list[LLMUsage], exp_id: str | None) -> None:
        for u in usages:
            self.record.total_cost_usd += u.cost_usd
            self.record.total_input_tokens += u.input_tokens
            self.record.total_output_tokens += u.output_tokens
            self.emitter.emit(LLMCall(run_id=self.run_id, exp_id=exp_id, usage=u))

    def context(self, exp_index: int) -> ProposalContext:
        kept = sorted(
            (
                KeptSolution(r.id, r.code, r.cv.mean)
                for r in self.ledger.records
                if r.status == Decision.keep and r.cv is not None
            ),
            key=lambda k: -k.cv_mean,
        )
        return ProposalContext(
            profile=self.h.profile,
            description=self.description,
            contract_doc=self.contract_doc,
            allowed_imports=self.allowed,
            best_code=self.best.code if self.best else self.starter,
            best_exp_id=self.best.exp_id if self.best else None,
            best_cv=self.best.result.cv if self.best else None,
            ledger_summary=self.ledger.summary(),
            kept=kept,
            exp_index=exp_index,
            since_last_keep=self.since_last_keep,
        )

    def _evaluate(self, code: str, exp_id: str, attempt: int) -> ExecResult:
        with otel.span("sandbox", exp_id=exp_id, attempt=attempt) as sp:
            res = self.h.evaluate(code, exp_id)
            if res.ok and res.cv is None:
                res = res.model_copy(
                    update={
                        "ok": False,
                        "error_kind": "invalid_output",
                        "error_tail": "harness returned no CV score",
                    }
                )
            otel.set_attrs(sp, ok=res.ok, error_kind=res.error_kind)
        self.emitter.emit(
            SandboxFinished(
                run_id=self.run_id,
                exp_id=exp_id,
                attempt=attempt,
                ok=res.ok,
                duration_s=res.duration_s,
                error_kind=res.error_kind,
                error_tail=res.error_tail,
            )
        )
        return res

    def evaluate_with_repairs(self, exp_id: str, code: str, ctx: ProposalContext) -> _Outcome:
        res = self._evaluate(code, exp_id, 0)
        out = _Outcome(code, res, 0)
        while not out.result.ok and out.repairs < self.max_repairs:
            try:
                with otel.span("llm_call", purpose="repair", exp_id=exp_id):
                    rep = self.proposer.repair(
                        ctx, out.code, out.result.error_tail or out.result.error_kind or ""
                    )
            except Exception as exc:
                usages = exc.usages if isinstance(exc, ProposalFailed) else []
                self._account(usages, exp_id)
                out.usages += usages
                print(f"[autotinker] repair of {exp_id} failed: {exc}", file=sys.stderr)
                break
            self._account(rep.usages, exp_id)
            out.usages += rep.usages
            out.repairs += 1
            out.code = rep.code
            out.result = self._evaluate(rep.code, exp_id, out.repairs)
        if out.result.ok and out.result.cv is not None:
            r = out.result
            assert r.cv is not None
            self.emitter.emit(
                ExperimentScored(
                    run_id=self.run_id,
                    exp_id=exp_id,
                    cv=r.cv,
                    select_score=r.select_score if r.select_score is not None else r.cv.mean,
                    fit_time_s=r.fit_time_s or 0.0,
                    loc=count_loc(out.code),
                )
            )
        return out

    def experiment(
        self,
        exp_id: str,
        idea: Idea,
        code: str,
        usages: list[LLMUsage],
        ctx: ProposalContext,
        *,
        gate: Gate | None,
        force_keep: bool = False,
    ) -> ExperimentRecord:
        started = _now()
        t = time.perf_counter()
        parent = self.best
        parent_id = parent.exp_id if parent else None
        with otel.span("experiment", exp_id=exp_id, idea=idea.title, category=idea.category.value) as sp:
            self.emitter.emit(
                ExperimentStarted(run_id=self.run_id, exp_id=exp_id, parent_id=parent_id, idea=idea)
            )
            self._account(usages, exp_id)
            out = self.evaluate_with_repairs(exp_id, code, ctx)
            res = out.result
            loc = count_loc(out.code)
            prev_mean = parent.result.cv.mean if parent and parent.result.cv else None
            if not res.ok:
                decision, reason = (
                    Decision.crash,
                    f"{res.error_kind or 'error'} after {out.repairs} repair attempt(s)",
                )
            elif parent is None or force_keep:
                decision, reason = Decision.keep, "baseline" if parent is None else "single-shot solution"
            else:
                assert gate is not None
                decision, reason = gate(Candidate(res, loc), Candidate(parent.result, parent.loc))
            if decision == Decision.keep:
                self.best = _Best(exp_id, out.code, res, loc)
                self.since_last_keep = 0
            else:
                self.since_last_keep += 1
            otel.set_attrs(sp, decision=decision.value)
            best = self.best
            self.emitter.emit(
                DecisionMade(
                    run_id=self.run_id,
                    exp_id=exp_id,
                    decision=decision,
                    reason=reason,
                    best_exp_id=best.exp_id if best else exp_id,
                    best_cv_mean=best.result.cv.mean if best and best.result.cv else 0.0,
                )
            )
        rec = ExperimentRecord(
            id=exp_id,
            parent_id=parent_id,
            idea=idea,
            code=out.code,
            diff=unified_diff(
                parent.code if parent else self.starter, out.code, parent_id or "starter", exp_id
            ),
            status=decision,
            reason=reason,
            cv=res.cv,
            select_score=res.select_score,
            fit_time_s=res.fit_time_s,
            loc=loc,
            repair_attempts=out.repairs,
            error_kind=res.error_kind,
            error_tail=res.error_tail,
            llm_calls=[*usages, *out.usages],
            cost_usd=sum(u.cost_usd for u in [*usages, *out.usages]),
            duration_s=time.perf_counter() - t,
            started_at=started,
        )
        self.ledger.append(rec)
        self.record.experiments.append(rec)
        if self.best is not None and self.best.result.cv is not None:
            gain = None
            if decision == Decision.keep and prev_mean is not None:
                gain = self.best.result.cv.mean - prev_mean
            self.history.append(
                HistoryPoint(
                    exp_id=exp_id,
                    status=decision.value,
                    radical=idea.radical,
                    best_mean=self.best.result.cv.mean,
                    best_se=self.best.result.cv.se,
                    keep_gain=gain,
                )
            )
        self.save()
        return rec

    def failed_proposal(self, exp_id: str, exc: Exception) -> None:
        usages = exc.usages if isinstance(exc, ProposalFailed) else []
        self._account(usages, exp_id)
        idea = Idea(title="(proposal failed)", rationale=str(exc)[:500], category=IdeaCategory.repair)
        parent = self.best
        self.emitter.emit(
            ExperimentStarted(
                run_id=self.run_id, exp_id=exp_id, parent_id=parent.exp_id if parent else None, idea=idea
            )
        )
        self.since_last_keep += 1
        best = self.best
        self.emitter.emit(
            DecisionMade(
                run_id=self.run_id,
                exp_id=exp_id,
                decision=Decision.crash,
                reason=f"proposal failed: {exc}"[:1000],
                best_exp_id=best.exp_id if best else exp_id,
                best_cv_mean=best.result.cv.mean if best and best.result.cv else 0.0,
            )
        )
        rec = ExperimentRecord(
            id=exp_id,
            parent_id=parent.exp_id if parent else None,
            idea=idea,
            code="",
            status=Decision.crash,
            reason=f"proposal failed: {exc}"[:1000],
            error_kind="proposal",
            error_tail=str(exc)[-2000:],
            llm_calls=usages,
            cost_usd=sum(u.cost_usd for u in usages),
            started_at=_now(),
        )
        self.ledger.append(rec)
        self.record.experiments.append(rec)
        self.save()

    def finish(self, stop: StopDecision) -> RunRecord:
        reason: StopReason = stop.reason or "user"
        self.emitter.emit(
            Stopped(run_id=self.run_id, reason=reason, report=stop.report, summary=stop.summary)
        )
        self.record.stop = {"reason": reason, "summary": stop.summary, "report": stop.report}
        best = self.best
        if best is None or best.result.cv is None:
            self.record.wall_time_s = self.elapsed
            self.save()
            self.emitter.close()
            raise RuntimeError("no valid solution was produced; see run.json for the errors")
        with otel.span("score_test", exp_id=best.exp_id):
            test = float(self.h.score_test(best.code))
        sel = best.result.select_score if best.result.select_score is not None else best.result.cv.mean
        gap = sel - test
        self.record.best_exp_id = best.exp_id
        self.record.final = FinalScores(
            best_exp_id=best.exp_id,
            dev_cv_mean=best.result.cv.mean,
            select_score=sel,
            test_score=test,
            optimism_gap=gap,
        )
        self.record.wall_time_s = self.elapsed
        self.emitter.emit(
            RunFinished(
                run_id=self.run_id,
                best_exp_id=best.exp_id,
                dev_cv_mean=best.result.cv.mean,
                select_score=sel,
                test_score=test,
                optimism_gap=gap,
                n_experiments=len(self.record.experiments),
                total_cost_usd=self.record.total_cost_usd,
                wall_time_s=self.record.wall_time_s,
            )
        )
        self.save()
        if self.run_dir is not None:
            (self.run_dir / "best_solution.py").write_text(best.code, encoding="utf-8")
        self.emitter.close()
        return self.record

    def save(self) -> None:
        self.record.wall_time_s = self.elapsed
        if self.best is not None:
            self.record.best_exp_id = self.best.exp_id
        if self.run_dir is not None:
            tmp = self.run_dir / "run.json.tmp"
            tmp.write_text(self.record.model_dump_json(indent=2), encoding="utf-8")
            tmp.replace(self.run_dir / "run.json")


def _common_config(
    mode: str, proposer: Proposer, max_repairs: int, extra: dict[str, Any] | None
) -> dict[str, Any]:
    cfg: dict[str, Any] = {"mode": mode, "proposer": proposer.label, "max_repairs": max_repairs}
    model = getattr(getattr(proposer, "llm", None), "model", None)
    if model:
        cfg["model"] = model
    cfg.update(extra or {})
    return cfg


def run_single(
    harness: HarnessProtocol,
    proposer: Proposer,
    *,
    run_dir: Path | None = None,
    run_id: str | None = None,
    task: TaskSpec | None = None,
    description: str = "",
    starter_code: str | None = None,
    contract_doc: str | None = None,
    allowed_imports: frozenset[str] | None = None,
    max_repairs: int = 3,
    on_event: Callable[[Any], None] | None = None,
    events_stdout: bool = False,
    config: dict[str, Any] | None = None,
) -> RunRecord:
    """Mode "run": one draft, evaluated with up to `max_repairs` repairs. If the draft never runs, the
    starter solution is evaluated as a fallback so the run still ends with a scored solution."""
    r = _Runner(
        harness,
        proposer,
        mode="run",
        run_dir=run_dir,
        run_id=run_id,
        task=task,
        description=description,
        starter_code=starter_code,
        contract_doc=contract_doc,
        allowed_imports=allowed_imports,
        max_repairs=max_repairs,
        on_event=on_event,
        events_stdout=events_stdout,
        config=_common_config("run", proposer, max_repairs, config),
    )
    r.emit_start()
    with otel.span("run", run_id=r.run_id, mode="run"):
        ctx = r.context(0)
        try:
            with otel.span("llm_call", purpose="draft"):
                prop: Proposal = proposer.draft(ctx)
        except Exception as exc:
            r.failed_proposal("e000", exc)
        else:
            r.experiment("e000", prop.idea, prop.code, prop.usages, ctx, gate=None, force_keep=True)
        if r.best is None:
            idea = Idea(
                title="Fallback: starter solution",
                rationale="the draft could not be made to run",
                category=IdeaCategory.baseline,
            )
            r.experiment("e001", idea, r.starter, [], r.context(1), gate=None)
        summary = (
            f"single-shot run finished after {len(r.record.experiments)} experiment(s) "
            f"({sum(e.repair_attempts for e in r.record.experiments)} repair attempt(s))"
        )
        return r.finish(StopDecision(True, "max_experiments", {}, summary))


def evolve(
    harness: HarnessProtocol,
    proposer: Proposer,
    *,
    gate: Gate | None = None,
    stop_rule: StopRule | None = None,
    budgets: dict[str, Any] | None = None,
    on_event: Callable[[Any], None] | None = None,
    run_dir: Path | None = None,
    run_id: str | None = None,
    task: TaskSpec | None = None,
    description: str = "",
    starter_code: str | None = None,
    contract_doc: str | None = None,
    allowed_imports: frozenset[str] | None = None,
    max_repairs: int = 3,
    max_consecutive_proposal_failures: int = 3,
    events_stdout: bool = False,
    config: dict[str, Any] | None = None,
) -> RunRecord:
    """Mode "evolve": hill-climb from the starter baseline until the stop rule fires."""
    gate = gate or StatGate()
    stop_rule = stop_rule or StopRule()
    for k, v in (budgets or {}).items():
        if not hasattr(stop_rule, k):
            raise ValueError(f"unknown budget {k!r}")
        setattr(stop_rule, k, v)
    cfg = _common_config("evolve", proposer, max_repairs, config)
    cfg["gate"] = {k: v for k, v in vars(gate).items()} if hasattr(gate, "__dict__") else {"name": gate.name}
    cfg["stop_rule"] = dict(vars(stop_rule))
    r = _Runner(
        harness,
        proposer,
        mode="evolve",
        run_dir=run_dir,
        run_id=run_id,
        task=task,
        description=description,
        starter_code=starter_code,
        contract_doc=contract_doc,
        allowed_imports=allowed_imports,
        max_repairs=max_repairs,
        on_event=on_event,
        events_stdout=events_stdout,
        config=cfg,
    )
    r.emit_start()
    with otel.span("run", run_id=r.run_id, mode="evolve"):
        baseline = Idea(title="Baseline: unmodified starter solution", category=IdeaCategory.baseline)
        r.experiment("e000", baseline, r.starter, [], r.context(0), gate=gate)
        failures = 0
        decision = StopDecision(False, None)
        try:
            while True:
                n = len(r.record.experiments)
                decision = stop_rule.check(r.history, n_experiments=n, cost_usd=r.cost, elapsed_s=r.elapsed)
                if decision.stop:
                    break
                exp_id = f"e{n:03d}"
                ctx = r.context(n)
                try:
                    with otel.span("llm_call", purpose="propose", exp_id=exp_id):
                        prop = proposer.draft(ctx) if r.best is None else proposer.propose_and_implement(ctx)
                except Exception as exc:
                    failures += 1
                    print(f"[autotinker] proposal for {exp_id} failed: {exc}", file=sys.stderr)
                    r.failed_proposal(exp_id, exc)
                    fatal = is_fatal_llm_error(exc)
                    if fatal or failures >= max_consecutive_proposal_failures:
                        decision = StopDecision(
                            True,
                            "proposer_failure",
                            stop_rule.signals(r.history),
                            f"aborted at experiment {exp_id}: the LLM rejected the credentials ({exc})"
                            if fatal
                            else f"aborted at experiment {exp_id}: the proposer failed {failures} times "
                            f"in a row ({exc})",
                        )
                        break
                    continue
                failures = 0
                r.experiment(exp_id, prop.idea, prop.code, prop.usages, ctx, gate=gate)
        except KeyboardInterrupt:
            decision = StopDecision(
                True,
                "user",
                stop_rule.signals(r.history),
                f"stopped by the user after {len(r.record.experiments)} experiments",
            )
        return r.finish(decision)
