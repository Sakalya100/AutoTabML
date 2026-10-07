"""Public SDK surface.

from autotinker import AutoTinker
at = AutoTinker(llm="anthropic:claude-sonnet-5-5")        # or llm="heuristic" (offline, no API key)
run = at.evolve("data.csv", target="price", until="ceiling", max_cost_usd=5, on_event=print)
run.leaderboard; run.best.code; run.stop_report; run.test_score
run.predict(new_df); run.export("pipeline/")
"""

from __future__ import annotations

import os
import platform
import sys
from collections.abc import Callable
from importlib import metadata
from pathlib import Path
from typing import Any, Literal

import pandas as pd

from autotinker.agent.proposer import Proposer, make_proposer
from autotinker.contracts import Metric, ProblemType, TaskSpec
from autotinker.evolve.gate import make_gate
from autotinker.evolve.loop import evolve as _evolve
from autotinker.evolve.loop import new_run_id
from autotinker.evolve.loop import run_single as _run_single
from autotinker.evolve.stopping import StopRule
from autotinker.obs.record import ExperimentRecord, RunRecord

DEFAULT_LLM = "anthropic:claude-sonnet-5-5"
CHEAP_LLM = "anthropic:claude-haiku-4-5"


def resolve_llm(llm: str | None) -> str:
    """ "auto"/None -> Anthropic if ANTHROPIC_API_KEY is set, else the offline heuristic proposer."""
    if llm in (None, "", "auto"):
        if os.environ.get("ANTHROPIC_API_KEY"):
            return DEFAULT_LLM
        print(
            "[autotinker] ANTHROPIC_API_KEY is not set: using the offline heuristic proposer (no LLM). "
            "Pass --llm anthropic:<model> (or another provider) to use an LLM.",
            file=sys.stderr,
        )
        return "heuristic"
    return llm


class Run:
    """The result of `AutoTinker.run` / `AutoTinker.evolve` (or `Run.load("run.json")`)."""

    def __init__(self, record: RunRecord, run_dir: Path | None = None, train_df: pd.DataFrame | None = None):
        self.record = record
        self.run_dir = run_dir
        self._train_df = train_df
        self._fitted: Any = None
        self._classes: list[Any] | None = None

    @classmethod
    def load(cls, path: str | Path) -> Run:
        p = Path(path)
        if p.is_dir():
            p = p / "run.json"
        return cls(RunRecord.model_validate_json(p.read_text(encoding="utf-8")), p.parent)

    # ------------------------------------------------------------ views

    @property
    def best(self) -> ExperimentRecord:
        for e in self.record.experiments:
            if e.id == self.record.best_exp_id:
                return e
        raise LookupError("this run has no best experiment")

    @property
    def test_score(self) -> float | None:
        """Locked-test score of the best solution (oriented: higher is better), scored exactly once."""
        return self.record.final.test_score if self.record.final else None

    @property
    def stop_report(self) -> dict[str, Any]:
        return self.record.stop or {}

    @property
    def leaderboard(self) -> pd.DataFrame:
        rows = []
        for e in self.record.experiments:
            rows.append(
                {
                    "id": e.id,
                    "parent": e.parent_id,
                    "status": e.status.value,
                    "category": e.idea.category.value,
                    "radical": e.idea.radical,
                    "idea": e.idea.title,
                    "cv_mean": e.cv.mean if e.cv else None,
                    "cv_se": e.cv.se if e.cv else None,
                    "select": e.select_score,
                    "fit_time_s": e.fit_time_s,
                    "loc": e.loc,
                    "repairs": e.repair_attempts,
                    "cost_usd": e.cost_usd,
                    "reason": e.reason,
                }
            )
        return pd.DataFrame(rows)

    def __repr__(self) -> str:
        f = self.record.final
        score = f"best={f.best_exp_id} cv={f.dev_cv_mean:.4f} test={f.test_score:.4f}" if f else "unfinished"
        return f"<Run {self.record.run_id} mode={self.record.mode} n={len(self.record.experiments)} {score}>"

    # ------------------------------------------------------------ use the solution

    def predict(self, df: pd.DataFrame, *, train_df: pd.DataFrame | None = None) -> Any:
        """Refit the best pipeline on all labelled data, in-process, then predict `df`.

        TRUST CAVEAT: this executes the generated solution.py in *this* Python process, without the
        sandbox. It only ever runs code that already passed the harness's static checks and sandboxed
        evaluation, but if you do not trust the run's provenance, read `run.best.code` first or use
        `run.export()` and run it in an isolated environment.
        """
        if self._fitted is None:
            train = train_df if train_df is not None else self._train_df
            if train is None:
                raise ValueError("no training data attached to this run: pass train_df=")
            best = self.best
            if best.status.value != "keep" or best.cv is None:
                raise RuntimeError("the best experiment did not pass the sandbox; refusing to execute it")
            target = self.record.task.target
            ns: dict[str, Any] = {"__name__": "autotinker_solution"}
            exec(compile(best.code, "solution.py", "exec"), ns)
            est = ns["build_pipeline"](self.record.profile.model_dump(mode="json"))
            X, y = train.drop(columns=[target]), train[target]
            if self.record.profile.problem_type != ProblemType.regression:
                # same encoding as the harness: class i = i-th class in sorted order
                codes, uniques = pd.factorize(y, sort=True)
                self._classes = list(uniques)
                est.fit(X, codes)
            else:
                est.fit(X, y.astype(float))
            self._fitted = est
        target = self.record.task.target
        X_new = df.drop(columns=[target]) if target in df.columns else df
        pred = self._fitted.predict(X_new)
        if self._classes is not None:
            return pd.Series([self._classes[int(i)] for i in pred], index=X_new.index, name=target)
        return pd.Series(pred, index=X_new.index, name=target)

    def export(self, out_dir: str | Path) -> Path:
        """Write a standalone project: solution.py, train.py, requirements.txt, README.md, run.json."""
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        best = self.best
        (out / "solution.py").write_text(best.code, encoding="utf-8")
        (out / "run.json").write_text(self.record.model_dump_json(indent=2), encoding="utf-8")
        (out / "profile.json").write_text(self.record.profile.model_dump_json(indent=2), encoding="utf-8")
        reqs = []
        for pkg in ("scikit-learn", "pandas", "numpy", "scipy", "lightgbm", "xgboost", "catboost"):
            mod = {"scikit-learn": "sklearn"}.get(pkg, pkg)
            if mod in best.code or pkg in ("scikit-learn", "pandas", "numpy"):
                try:
                    reqs.append(f"{pkg}=={metadata.version(pkg)}")
                except metadata.PackageNotFoundError:
                    reqs.append(pkg)
        (out / "requirements.txt").write_text("\n".join(reqs) + "\n", encoding="utf-8")
        t = self.record.task
        problem = self.record.profile.problem_type.value
        (out / "train.py").write_text(_TRAIN_PY.format(target=t.target, problem=problem), encoding="utf-8")
        f = self.record.final
        metric: Metric = self.record.profile.metric
        scores = (
            f"| dev CV ({metric.value}) | {metric.to_raw(f.dev_cv_mean):.5f} |\n"
            f"| select holdout | {metric.to_raw(f.select_score):.5f} |\n"
            f"| locked test | {metric.to_raw(f.test_score):.5f} |\n"
            f"| optimism gap (select - test, oriented) | {f.optimism_gap:+.5f} |\n"
            if f
            else ""
        )
        (out / "README.md").write_text(
            f"# AutoTinker solution: {t.target} ({problem})\n\n"
            f"Run `{self.record.run_id}` ({self.record.mode}, proposer `{self.record.proposer}`), "
            f"best experiment `{best.id}`: {best.idea.title}\n\n"
            f"| score | value |\n|---|---|\n{scores}\n"
            f"Stop: {self.stop_report.get('summary', '')}\n\n"
            "## Use it\n\n```bash\npip install -r requirements.txt\n"
            "python train.py train.csv test.csv predictions.csv\n```\n\n"
            "`solution.py` defines `build_pipeline(profile)`, returning an unfitted scikit-learn pipeline "
            "that "
            "takes the raw feature DataFrame. `profile.json` is the dataset profile it was written for. "
            "This project does not depend on autotinker.\n",
            encoding="utf-8",
        )
        return out


_TRAIN_PY = '''"""Standalone trainer for the exported AutoTinker solution (no autotinker dependency).

usage: python train.py train.csv new_data.csv predictions.csv
"""
import json
import sys

import pandas as pd

from solution import build_pipeline

TARGET = {target!r}
PROBLEM = {problem!r}


def main(train_path, new_path, out_path):
    profile = json.load(open("profile.json"))
    train = pd.read_csv(train_path)
    X, y = train.drop(columns=[TARGET]), train[TARGET]
    est = build_pipeline(profile)
    if PROBLEM == "regression":
        est.fit(X, y.astype(float))
        classes = None
    else:
        codes, classes = pd.factorize(y, sort=True)
        est.fit(X, codes)
    new = pd.read_csv(new_path)
    pred = est.predict(new.drop(columns=[TARGET], errors="ignore"))
    if classes is not None:
        pred = [classes[int(i)] for i in pred]
    pd.DataFrame({{TARGET: pred}}).to_csv(out_path, index=False)


if __name__ == "__main__":
    main(*sys.argv[1:4])
'''


class AutoTinker:
    def __init__(
        self,
        llm: str | None = "auto",
        workdir: str | Path = "runs",
        *,
        cheap_llm: str | None = None,
        gate: Literal["stat", "naive"] = "stat",
        seed: int = 0,
        max_repairs: int = 3,
        proposer: Proposer | None = None,
    ) -> None:
        self.llm_spec = resolve_llm(llm) if proposer is None else proposer.label
        self.cheap_llm = cheap_llm
        self.workdir = Path(workdir)
        self.gate_name = gate
        self.seed = seed
        self.max_repairs = max_repairs
        self._proposer = proposer

    def _proposer_for_run(self) -> Proposer:
        if self._proposer is not None:
            return self._proposer
        return make_proposer(self.llm_spec, cheap=self.cheap_llm, seed=self.seed)

    def _prepare(
        self,
        data: str | Path | pd.DataFrame,
        target: str,
        description: str,
        metric: str | Metric | None,
        problem_type: str | ProblemType | None,
        run_id: str | None,
        task_kwargs: dict[str, Any],
    ) -> tuple[pd.DataFrame, TaskSpec, Any, Path, str]:
        from autotinker.data.sources import load_dataframe, load_source
        from autotinker.harness import Harness

        if isinstance(data, pd.DataFrame):
            df, stem = load_dataframe(data), "dataframe"
        else:
            df, stem = load_source(str(data)), Path(str(data)).stem.replace(":", "-")
        if target not in df.columns:
            raise ValueError(f"target column {target!r} not found; columns: {list(df.columns)}")
        task = TaskSpec(
            target=target,
            description=description,
            metric=Metric(metric) if metric else None,
            problem_type=ProblemType(problem_type) if problem_type else None,
            seed=self.seed,
            **task_kwargs,
        )
        rid = run_id or new_run_id(stem)
        run_dir = (self.workdir / rid).resolve()  # absolute: the sandbox worker runs with another cwd
        run_dir.mkdir(parents=True, exist_ok=True)
        harness = Harness(df, task, run_dir / "harness")
        task = getattr(harness, "task", task)
        return df, task, harness, run_dir, rid

    def _env(self) -> dict[str, Any]:
        return {"python": platform.python_version(), "llm": self.llm_spec, "seed": self.seed}

    def evolve(
        self,
        data: str | Path | pd.DataFrame,
        target: str,
        *,
        description: str = "",
        metric: str | Metric | None = None,
        problem_type: str | ProblemType | None = None,
        max_experiments: int | None = 50,
        max_cost_usd: float | None = 5.0,
        max_time_s: float | None = None,
        until: Literal["ceiling", "budget"] = "ceiling",
        min_experiments: int = 10,
        radical_k: int = 4,
        external_ref: float | None = None,
        on_event: Callable[[Any], None] | None = None,
        events_stdout: bool = False,
        run_id: str | None = None,
        **task_kwargs: Any,
    ) -> Run:
        """Hill-climb from the harness's starter solution until the ceiling (or a budget) is reached."""
        df, task, harness, run_dir, rid = self._prepare(
            data, target, description, metric, problem_type, run_id, task_kwargs
        )
        stop_rule = StopRule(
            until=until,
            min_experiments=min_experiments,
            radical_k=radical_k,
            external_ref=external_ref,
            max_experiments=max_experiments,
            max_cost_usd=max_cost_usd,
            max_time_s=max_time_s,
        )
        record = _evolve(
            harness,
            self._proposer_for_run(),
            gate=(
                make_gate("stat", test_train_ratio=1.0 / max(task.cv_folds - 1, 1))
                if self.gate_name == "stat"
                else make_gate(self.gate_name)
            ),
            stop_rule=stop_rule,
            on_event=on_event,
            run_dir=run_dir,
            run_id=rid,
            task=task,
            description=description,
            allowed_imports=frozenset(getattr(harness, "allowed_imports", frozenset())),
            max_repairs=self.max_repairs,
            events_stdout=events_stdout,
            config={
                "env": self._env(),
                "source": str(data) if not isinstance(data, pd.DataFrame) else "dataframe",
            },
        )
        return Run(record, run_dir, df)

    def run(
        self,
        data: str | Path | pd.DataFrame,
        target: str,
        *,
        description: str = "",
        metric: str | Metric | None = None,
        problem_type: str | ProblemType | None = None,
        on_event: Callable[[Any], None] | None = None,
        events_stdout: bool = False,
        run_id: str | None = None,
        **task_kwargs: Any,
    ) -> Run:
        """Single shot: draft one solution, repair it up to `max_repairs` times, score it."""
        df, task, harness, run_dir, rid = self._prepare(
            data, target, description, metric, problem_type, run_id, task_kwargs
        )
        record = _run_single(
            harness,
            self._proposer_for_run(),
            run_dir=run_dir,
            run_id=rid,
            task=task,
            description=description,
            allowed_imports=frozenset(getattr(harness, "allowed_imports", frozenset())),
            max_repairs=self.max_repairs,
            on_event=on_event,
            events_stdout=events_stdout,
            config={
                "env": self._env(),
                "source": str(data) if not isinstance(data, pd.DataFrame) else "dataframe",
            },
        )
        return Run(record, run_dir, df)


def load_run(path: str | Path) -> Run:
    return Run.load(path)


__all__ = ["AutoTinker", "Run", "agentic_run", "load_run", "resolve_llm"]


# ---------------------------------------------------------------- agentic (v3)


def agentic_run(
    source: str | Path | pd.DataFrame,
    *,
    target: str | None = None,
    goal: str = "",
    metric: str | None = None,
    workdir: str | Path = "runs",
    backend: Any = None,
    max_experiments: int = 10,
    max_time_s: float = 40 * 60,
    max_tokens: int = 400_000,
    seed: int = 0,
    on_event: Callable[[Any], None] | None = None,
    events_stdout: bool = False,
    run_id: str | None = None,
    config: Any = None,
    **task_kwargs: Any,
) -> Run:
    """The agentic loop: intake, profile, baseline, drafts, improve/tune, ensemble, locked test, report.

    `backend` is any ChatBackend (default: the provider Router over the keys in the environment)."""
    from autotinker.agent.router import Router
    from autotinker.data.sources import load_dataframe, load_source, source_stem
    from autotinker.evolve.agentic import AgenticConfig, run_agentic, run_intake
    from autotinker.harness import Harness

    if backend is None:
        backend = Router()
        if not backend.providers:
            raise RuntimeError(
                "no LLM provider is configured: set GROQ_API_KEY and/or GEMINI_API_KEY (see .env), "
                "or use `autotinker evolve --llm heuristic` for the offline path"
            )
    if isinstance(source, pd.DataFrame):
        df, stem = load_dataframe(source), "dataframe"
    else:
        df, stem = load_source(str(source)), source_stem(str(source))
    if target is not None and target not in df.columns:
        raise ValueError(f"target column {target!r} not found; columns: {list(df.columns)}")
    intake = run_intake(backend, df, goal=goal, target=target, metric=metric)
    task = TaskSpec(
        target=intake.target,
        description=goal,
        metric=intake.metric,
        problem_type=None,
        seed=seed,
        **task_kwargs,
    )
    rid = run_id or new_run_id(stem)
    run_dir = (Path(workdir) / rid).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    harness = Harness(df, task, run_dir / "harness")
    cfg = config or AgenticConfig()
    cfg.max_experiments = max_experiments
    cfg.max_time_s = max_time_s
    cfg.max_tokens = max_tokens
    record = run_agentic(
        harness,
        backend,
        cfg=cfg,
        goal=intake.goal or goal,
        intake=intake,
        run_dir=run_dir,
        run_id=rid,
        task=harness.task,
        on_event=on_event,
        events_stdout=events_stdout,
        config={
            "env": {"python": platform.python_version(), "seed": seed},
            "source": str(source) if not isinstance(source, pd.DataFrame) else "dataframe",
            "intake": {
                "target": intake.target,
                "metric": intake.metric.value if intake.metric else None,
                "warnings": intake.warnings,
            },
        },
    )
    return Run(record, run_dir, df)
