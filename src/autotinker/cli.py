"""Command-line interface: `autotinker run|evolve|replay|schema`.

With `--events-stdout`, stdout carries ONLY the JSONL event stream (one event per line, see
autotinker/obs/events.py); every human-readable message goes to stderr. The web app's local runner
relies on this.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.live import Live
from rich.table import Table

from autotinker.contracts import Metric

app = typer.Typer(
    add_completion=False, no_args_is_help=True, help="AutoTinker: a self-improving agent for tabular ML."
)
err = Console(stderr=True, width=None if sys.stderr.isatty() else 160)

_STATUS_STYLE = {"keep": "green", "discard": "yellow", "crash": "red"}


class LiveView:
    """Rich live table driven by the event stream (rendered on stderr)."""

    def __init__(self, title: str) -> None:
        self.title = title
        self.rows: dict[str, dict[str, Any]] = {}
        self.metric: Metric | None = None
        self.cost = 0.0
        self.footer = ""
        self.live = Live(self.render(), console=err, refresh_per_second=4, transient=False)

    def fmt(self, v: float | None) -> str:
        if v is None:
            return ""
        return f"{self.metric.to_raw(v):.6g}" if self.metric else f"{v:.6g}"

    def render(self) -> Table:
        t = Table(title=self.title, caption=self.footer or None, expand=False)
        for col in ("exp", "status", "idea", "cv", "±se", "select", "loc", "rep", "note"):
            wide = col in ("idea", "note")
            t.add_column(
                col,
                no_wrap=True,
                overflow="ellipsis",
                max_width=44 if wide else None,
                min_width=None if wide else len(col) + 3,
            )
        for r in list(self.rows.values())[-30:]:
            st = r.get("status", "running")
            t.add_row(
                r["id"],
                f"[{_STATUS_STYLE.get(st, 'cyan')}]{st}[/]",
                r.get("idea", ""),
                self.fmt(r.get("cv")),
                f"{r['se']:.4g}" if r.get("se") is not None else "",
                self.fmt(r.get("select")),
                str(r.get("loc", "")),
                str(r.get("rep", "")),
                r.get("note", "")[:120],
            )
        return t

    def __call__(self, ev: Any) -> None:
        typ = ev.type
        if typ == "run_started":
            self.metric = ev.profile.metric
            self.title = (
                f"{self.title} · {ev.profile.problem_type.value} · {ev.profile.metric.value} · {ev.proposer}"
            )
        elif typ == "experiment_started":
            tag = " [radical]" if ev.idea.radical else ""
            self.rows[ev.exp_id] = {"id": ev.exp_id, "idea": ev.idea.title + tag}
        elif typ == "llm_call":
            self.cost += ev.usage.cost_usd
        elif typ == "agent_step_finished" and ev.exp_id:
            r = self.rows.setdefault(ev.exp_id, {"id": ev.exp_id})
            if ev.step.role not in ("executor",):
                r["note"] = f"{ev.step.role}: {ev.step.plain}"
        elif typ == "report_ready":
            self.footer += f"\n[bold]report[/]: {str(ev.report.get('summary', ''))[:400]}"
        elif typ == "sandbox_finished":
            r = self.rows.setdefault(ev.exp_id, {"id": ev.exp_id})
            r["rep"] = ev.attempt
            if not ev.ok:
                r["note"] = f"{ev.error_kind}"
        elif typ == "experiment_scored":
            r = self.rows[ev.exp_id]
            r.update(cv=ev.cv.mean, se=ev.cv.se, select=ev.select_score, loc=ev.loc)
        elif typ == "decision":
            r = self.rows[ev.exp_id]
            r["status"] = ev.decision.value
            r["note"] = ev.reason.split(";")[0]
            self.footer = f"best {ev.best_exp_id} cv {self.fmt(ev.best_cv_mean)} · cost ${self.cost:.4f}"
        elif typ == "stopped":
            self.footer = f"{self.footer}\n[bold]{ev.reason}[/]: {ev.summary}"
        elif typ == "run_finished":
            m = self.metric
            raw = (lambda v: m.to_raw(v)) if m else (lambda v: v)
            self.footer += (
                f"\nbest {ev.best_exp_id}: dev CV {raw(ev.dev_cv_mean):.6g} · "
                f"select {raw(ev.select_score):.6g} · "
                f"locked test {raw(ev.test_score):.6g} · optimism gap {ev.optimism_gap:+.4g} · "
                f"{ev.n_experiments} experiments · ${ev.total_cost_usd:.4f} · {ev.wall_time_s:.0f}s"
            )
        self.live.update(self.render())


def _make(llm: str | None, cheap_llm: str | None, out: Path, gate: str, seed: int, max_repairs: int) -> Any:
    from autotinker.api import AutoTinker

    return AutoTinker(
        llm=llm,
        workdir=out,
        cheap_llm=cheap_llm,
        gate=gate,  # type: ignore[arg-type]
        seed=seed,
        max_repairs=max_repairs,
    )


LLMOpt = Annotated[
    str | None,
    typer.Option(
        "--llm",
        help="'heuristic' (offline) or provider:model, e.g. anthropic:claude-sonnet-5-5. "
        "Default: Anthropic if ANTHROPIC_API_KEY is set, else heuristic.",
    ),
]


def _go(fn: Any, events_stdout: bool, title: str) -> Any:
    if events_stdout:
        return fn(None)
    view = LiveView(title)
    with view.live:
        return fn(view)


def load_env_file() -> None:
    """Load provider keys from ./.env (never overrides the real environment; values are never printed)."""
    try:
        from dotenv import find_dotenv, load_dotenv
    except ImportError:  # pragma: no cover - python-dotenv is a dependency
        return
    path = find_dotenv(usecwd=True)
    if path:
        load_dotenv(path, override=False)


@app.command()
def run(
    source: Annotated[
        str, typer.Argument(help="https:// link, CSV/parquet path, openml:<id> or kaggle:<owner>/<dataset>")
    ],
    target: Annotated[
        str | None, typer.Option("--target", "-t", help="column to predict (inferred by Intake if omitted)")
    ] = None,
    goal: Annotated[str, typer.Option("--goal", "-g", help='one sentence, e.g. "predict churn"')] = "",
    metric: Annotated[str | None, typer.Option("--metric")] = None,
    max_experiments: Annotated[int, typer.Option("--max-experiments")] = 10,
    max_time: Annotated[float, typer.Option("--max-time", help="seconds")] = 40 * 60,
    max_tokens: Annotated[
        int, typer.Option("--max-tokens", help="token cap across all agent calls")
    ] = 400_000,
    out: Annotated[Path, typer.Option("--out")] = Path("runs"),
    seed: Annotated[int, typer.Option("--seed")] = 0,
    events_stdout: Annotated[
        bool, typer.Option("--events-stdout", help="print ONLY JSONL events on stdout")
    ] = False,
    llm: Annotated[
        str | None,
        typer.Option("--llm", help="legacy single-shot mode with this proposer (e.g. 'heuristic')"),
    ] = None,
    cheap_llm: Annotated[str | None, typer.Option("--cheap-llm", help="legacy single-shot mode only")] = None,
    description: Annotated[str, typer.Option("--description", "-d", help="legacy alias of --goal")] = "",
    max_repairs: Annotated[int, typer.Option("--max-repairs", help="legacy single-shot mode only")] = 3,
    control_stdin: Annotated[
        bool,
        typer.Option(
            "--control-stdin",
            help='read JSONL control commands on stdin: {"type":"steer","text":…} / {"type":"stop"}',
        ),
    ] = False,
    control_fifo: Annotated[
        Path | None, typer.Option("--control-fifo", help="read JSONL control commands from this FIFO")
    ] = None,
    control_file: Annotated[
        Path | None,
        typer.Option("--control-file", help="poll this append-only JSONL file for control commands"),
    ] = None,
) -> None:
    """The agentic AutoML loop: agents profile, plan, code, debug, tune and ensemble until the ceiling.

    Provider keys (GROQ_API_KEY, GEMINI_API_KEY, ...) are read from the environment or ./.env.
    With --llm, runs the legacy single-shot mode instead (draft one solution, repair, score)."""
    goal = goal or description
    if llm is not None:
        if target is None:
            raise typer.BadParameter("--target is required with --llm (legacy single-shot mode)")
        at = _make(llm, cheap_llm, out, "stat", seed, max_repairs)
        res = _go(
            lambda cb: at.run(
                source, target, description=goal, metric=metric, on_event=cb, events_stdout=events_stdout
            ),
            events_stdout,
            f"autotinker run {source}",
        )
        err.print(f"run directory: {res.run_dir}")
        return
    load_env_file()
    from autotinker.api import agentic_run
    from autotinker.evolve.control import ControlChannel

    control: ControlChannel | None = None
    if control_fifo is not None:
        control = ControlChannel.from_fifo(control_fifo)
    elif control_file is not None:
        control = ControlChannel.from_file(control_file)
    elif control_stdin:
        control = ControlChannel.from_stdin()

    try:
        res = _go(
            lambda cb: agentic_run(
                source,
                target=target,
                goal=goal,
                metric=metric,
                workdir=out,
                max_experiments=max_experiments,
                max_time_s=max_time,
                max_tokens=max_tokens,
                seed=seed,
                on_event=cb,
                events_stdout=events_stdout,
                control=control,
            ),
            events_stdout,
            f"autotinker run {source}",
        )
    except (RuntimeError, ValueError) as exc:
        err.print(f"[red]error:[/] {exc}")
        raise typer.Exit(code=2) from exc
    err.print(f"run directory: {res.run_dir}")
    rep = res.record.report or {}
    if rep.get("summary"):
        err.print(f"[bold]report:[/] {rep['summary']}")
    stop = res.record.stop or {}
    if stop.get("reason") == "proposer_failure":
        err.print(f"[red]run aborted:[/] {stop.get('summary', '')}")
        raise typer.Exit(code=3)


@app.command()
def evolve(
    source: Annotated[str, typer.Argument(help="CSV/parquet path, openml:<id> or kaggle:<owner>/<dataset>")],
    target: Annotated[str, typer.Option("--target", "-t")],
    llm: LLMOpt = None,
    cheap_llm: Annotated[str | None, typer.Option("--cheap-llm")] = None,
    description: Annotated[str, typer.Option("--description", "-d")] = "",
    metric: Annotated[str | None, typer.Option("--metric")] = None,
    max_experiments: Annotated[int, typer.Option("--max-experiments")] = 50,
    max_cost: Annotated[float, typer.Option("--max-cost", help="USD")] = 5.0,
    max_time: Annotated[float | None, typer.Option("--max-time", help="seconds")] = None,
    until: Annotated[str, typer.Option("--until", help="ceiling | budget")] = "ceiling",
    min_experiments: Annotated[int, typer.Option("--min-experiments")] = 10,
    gate: Annotated[str, typer.Option("--gate", help="stat | naive")] = "stat",
    out: Annotated[Path, typer.Option("--out")] = Path("runs"),
    seed: Annotated[int, typer.Option("--seed")] = 0,
    max_repairs: Annotated[int, typer.Option("--max-repairs")] = 3,
    events_stdout: Annotated[
        bool, typer.Option("--events-stdout", help="print ONLY JSONL events on stdout")
    ] = False,
) -> None:
    """Self-improvement loop: hill-climb from the starter solution until the ceiling or a budget."""
    if until not in ("ceiling", "budget"):
        raise typer.BadParameter("--until must be 'ceiling' or 'budget'")
    at = _make(llm, cheap_llm, out, gate, seed, max_repairs)
    res = _go(
        lambda cb: at.evolve(
            source,
            target,
            description=description,
            metric=metric,
            max_experiments=max_experiments,
            max_cost_usd=max_cost,
            max_time_s=max_time,
            until=until,
            min_experiments=min_experiments,
            on_event=cb,
            events_stdout=events_stdout,
        ),
        events_stdout,
        f"autotinker evolve {source}",
    )
    err.print(f"run directory: {res.run_dir}")
    stop = res.record.stop or {}
    if stop.get("reason") == "proposer_failure":
        err.print(f"[red]run aborted:[/] {stop.get('summary', '')}")
        raise typer.Exit(code=3)


@app.command()
def replay(run_json: Annotated[Path, typer.Argument(help="path to run.json (or its directory)")]) -> None:
    """Print the experiment ledger and stop report of a finished run."""
    from autotinker.api import Run

    r = Run.load(run_json)
    rec = r.record
    m = rec.profile.metric
    con = Console(width=None if sys.stdout.isatty() else 160)
    t = Table(
        title=f"{rec.run_id} · {rec.mode} · {rec.proposer} · {rec.profile.problem_type.value} · {m.value}"
    )
    for col in ("exp", "parent", "status", "category", "idea", "cv", "±se", "select", "loc", "rep", "$"):
        t.add_column(col, no_wrap=True, overflow="ellipsis", max_width=56 if col == "idea" else None)
    for e in rec.experiments:
        st = e.status.value
        t.add_row(
            e.id,
            e.parent_id or "",
            f"[{_STATUS_STYLE.get(st, '')}]{st}[/]",
            e.idea.category.value + ("*" if e.idea.radical else ""),
            e.idea.title,
            f"{m.to_raw(e.cv.mean):.6g}" if e.cv else (e.error_kind or ""),
            f"{e.cv.se:.4g}" if e.cv else "",
            f"{m.to_raw(e.select_score):.6g}" if e.select_score is not None else "",
            str(e.loc),
            str(e.repair_attempts),
            f"{e.cost_usd:.4f}",
        )
    con.print(t)
    stop = rec.stop or {}
    con.print(f"[bold]stop[/] ({stop.get('reason', '?')}): {stop.get('summary', '')}")
    for name, sig in (stop.get("report") or {}).items():
        mark = "[green]fired[/]" if sig.get("fired") else "[yellow]not fired[/]"
        con.print(f"  {name}: {mark} - {sig.get('detail', '')}")
    if rec.final:
        f = rec.final
        con.print(
            f"[bold]best[/] {f.best_exp_id}: dev CV {m.to_raw(f.dev_cv_mean):.6g} · "
            f"select {m.to_raw(f.select_score):.6g}"
            f" · locked test {m.to_raw(f.test_score):.6g} · optimism gap {f.optimism_gap:+.4g} (oriented)"
        )
    con.print(
        f"cost ${rec.total_cost_usd:.4f} · tokens {rec.total_input_tokens}+{rec.total_output_tokens} · "
        f"{rec.wall_time_s:.0f}s"
    )


@app.command()
def schema(out_dir: Annotated[Path, typer.Argument()] = Path("schema")) -> None:
    """Write JSON Schemas for the event stream and RunRecord."""
    from autotinker.obs.schema import main

    main(str(out_dir))


def main() -> None:  # pragma: no cover
    app(prog_name="autotinker")


if __name__ == "__main__":  # pragma: no cover
    main()
