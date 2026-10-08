"""The nine roles: system prompts, compact input builders and model aliases (docs/AGENTIC_PLAN.md §2).

Inputs are sized for Groq's free tier (8K tokens per minute, counting prompt + max_tokens): profile
summaries rather than the full profile JSON, code excerpts of at most ~2K tokens, error tails.

PRIVACY: builders take `rows=True` only for roles that are sent with `privacy=True` (Intake, Profiler). Every
other builder uses `profile_text(..., rows=False)`, which omits sample rows, example cell values and top
categorical values, so its output may go to providers that train on inputs.
"""

from __future__ import annotations

import json
from typing import Any

from autotinker.agent.roles.base import RoleSpec
from autotinker.agent.roles.schemas import (
    FAMILIES,
    CodeOut,
    CriticOut,
    EnsemblerOut,
    IntakeOut,
    PlanOut,
    ProfilerOut,
    ReporterOut,
    TunerOut,
)
from autotinker.contracts import DataProfile, IdeaCategory

CODE_EXCERPT_CHARS = 7000  # ~2K tokens
ERROR_TAIL_CHARS = 2500

_PLAIN = (
    'Always include "plain": ONE short sentence a non-expert understands (no jargon, no numbers unless '
    "essential)."
)


def excerpt(text: str, limit: int = CODE_EXCERPT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n# ... (truncated) ...\n" + text[-half:]


def tail(text: str, limit: int = ERROR_TAIL_CHARS) -> str:
    return text if len(text) <= limit else "..." + text[-limit:]


def profile_text(profile: DataProfile, *, rows: bool, max_cols: int = 60) -> str:
    """Compact dataset summary. rows=False -> schema + summary statistics only (safe for any provider)."""
    m = profile.metric
    lines = [
        f"rows={profile.n_rows} features={len(profile.columns)} target={profile.target!r} "
        f"problem={profile.problem_type.value} metric={m.value} "
        f"({'higher' if m.greater_is_better else 'lower'} is better; scores shown oriented, higher=better)",
    ]
    ts = profile.target_summary
    if "classes" in ts and isinstance(ts["classes"], dict):
        counts = list(ts["classes"].values())
        if rows:
            lines.append(f"target classes: {json.dumps(ts['classes'])[:400]}")
        else:
            lines.append(f"target: {len(counts)} classes, counts {sorted(counts, reverse=True)[:10]}")
    else:
        keep = {k: v for k, v in ts.items() if isinstance(v, int | float)}
        lines.append(f"target stats: {json.dumps(keep)[:300]}")
    lines.append("columns (name: kind dtype missing% n_unique [stats] [flags]):")
    for c in profile.columns[:max_cols]:
        bits = [f"{c.kind.value} {c.dtype}", f"miss={c.missing_frac:.0%}", f"uniq={c.n_unique}"]
        if c.stats:
            s = c.stats
            bits.append(
                "mean={:.4g} std={:.4g} min={:.4g} max={:.4g}".format(
                    s.get("mean", float("nan")),
                    s.get("std", float("nan")),
                    s.get("min", float("nan")),
                    s.get("max", float("nan")),
                )
            )
        if rows and c.top_values:
            bits.append("top=" + json.dumps(dict(list(c.top_values.items())[:4]))[:120])
        if c.flags:
            bits.append("FLAGS=" + ",".join(c.flags))
        lines.append(f"- {c.name}: " + " ".join(bits))
    if len(profile.columns) > max_cols:
        lines.append(f"... and {len(profile.columns) - max_cols} more columns")
    if profile.warnings:
        lines.append("warnings: " + "; ".join(profile.warnings)[:600])
    if rows and profile.sample_rows:
        lines.append("sample rows: " + json.dumps(profile.sample_rows[:5], default=str)[:2500])
    return "\n".join(lines)


# ---------------------------------------------------------------- specs

INTAKE = RoleSpec(
    name="intake",
    alias="reason",
    output=IntakeOut,
    max_tokens=1500,
    reasoning_effort="low",
    system=f"""You are the Intake agent of AutoTinker, an AutoML system for tabular data. From a preview of a
CSV and the user's sentence, decide what to predict and how to score it.
- target: one column name copied EXACTLY from the header.
- problem_type: binary, multiclass or regression.
- metric: binary -> roc_auc (default); multiclass -> log_loss or accuracy; regression -> rmse (or mae/r2).
- goal: the user's goal in plain words. warnings: data problems you notice (IDs, leakage, few rows...).
{_PLAIN}
Reply with ONLY a JSON object: {{"target": "...", "problem_type": "...", "metric": "...", "goal": "...",
"warnings": ["..."], "plain": "..."}}""",
)

PROFILER = RoleSpec(
    name="profiler",
    alias="reason",
    output=ProfilerOut,
    max_tokens=1500,
    reasoning_effort="low",
    system=f"""You are the Profiler agent of AutoTinker. Given a code-computed profile of a tabular dataset,
write a short data story and list the risks that matter for modelling: leakage, ID-like columns, time order,
class imbalance, missing values, high-cardinality categoricals. Name columns the modellers must NOT use as
features (IDs, leaks) in drop_columns, copied exactly. Keep everything brief.
{_PLAIN}
Reply with ONLY a JSON object: {{"story": "...", "risks": ["..."], "drop_columns": ["..."],
"split_advice": "...", "plain": "..."}}""",
)

_CATS = ", ".join(c.value for c in IdeaCategory if c.value not in ("baseline", "repair"))

PLANNER = RoleSpec(
    name="planner",
    alias="reason",
    output=PlanOut,
    max_tokens=2000,
    reasoning_effort="low",
    system=f"""You are the Planner of AutoTinker, an autonomous tabular-ML research loop. Each experiment
tests ONE atomic hypothesis on solution.py (a scikit-learn pipeline). A frozen harness scores it with repeated
k-fold CV and a statistical gate keeps only real improvements; simpler code wins ties.
Propose exactly one idea. Never repeat an idea from the history. Prefer ideas with a clear reason to work on
THIS data. category is one of: {_CATS}.
family is the model family of the resulting solution, one of: {", ".join(FAMILIES)}.
radical=true only for a new model family / new approach / ensemble.
{_PLAIN}
Reply with ONLY a JSON object: {{"title": "<the hypothesis in one line>", "block": "<pipeline block it
changes: preprocessing|features|model|hyperparameters>", "rationale": "<1-2 sentences>", "category": "...",
"family": "...", "radical": false, "plain": "..."}}""",
)

_CODE_RULES = """Rules: all preprocessing must live inside the returned UNFITTED pipeline; never call fit,
never read files, never use the network; import only allowed modules; helper functions at module level;
keep the code short and readable; select columns by name from profile["columns"], never hard-code the
target column."""

CODER = RoleSpec(
    name="coder",
    alias="code",
    output=CodeOut,
    kind="code",
    max_tokens=4000,
    reasoning_effort="low",
    system=f"""You are the Coder of AutoTinker. You implement ONE idea as a complete solution.py.
{_CODE_RULES}
Reply format: first line = one plain-language sentence saying what you changed; then the COMPLETE file in a
single ```python block. Nothing after the block.""",
)

DEBUGGER = RoleSpec(
    name="debugger",
    alias="code",
    output=CodeOut,
    kind="code",
    max_tokens=4000,
    reasoning_effort="low",
    system=f"""You are the Debugger of AutoTinker. A solution.py failed in the sandbox. Fix the cause shown in
the error with the smallest change that keeps the idea intact.
{_CODE_RULES}
Reply format: first line = one plain-language sentence saying what was wrong and what you fixed; then the
COMPLETE corrected file in a single ```python block.""",
)

CRITIC = RoleSpec(
    name="critic",
    alias="reason",
    output=CriticOut,
    max_tokens=1500,
    reasoning_effort="low",
    system=f"""You are the Critic of AutoTinker. After an experiment is scored, audit it for leakage and
validity (preprocessing fitted outside the pipeline, target-derived features, ID or post-outcome columns,
time-order misuse, a too-good-to-be-true jump) and say in plain words what we learned.
verdict: "valid", "suspicious" or "leak". Only say "leak" with a concrete reason.
{_PLAIN}
Reply with ONLY a JSON object: {{"verdict": "...", "reasons": "...", "learned": "...", "plain": "..."}}""",
)

TUNER = RoleSpec(
    name="tuner",
    alias="reason",
    output=TunerOut,
    max_tokens=2000,
    reasoning_effort="low",
    system=f"""You are the Tuner of AutoTinker. Design a hyperparameter search space for the given
scikit-learn pipeline; Optuna will search it inside the sandbox (you do not run anything).
Use sklearn set_params paths that exist in the code: step names joined by "__", e.g. "model__learning_rate"
or "preprocess__num__strategy". 2-5 parameters, sensible ranges, log=true for scale-like parameters.
n_trials between 8 and 30.
{_PLAIN}
Reply with ONLY a JSON object: {{"params": {{"model__learning_rate": {{"type": "float", "low": 0.01,
"high": 0.3, "log": true}}, "model__max_depth": {{"type": "int", "low": 2, "high": 10}},
"model__loss": {{"type": "categorical", "choices": ["a", "b"]}}}}, "n_trials": 20, "rationale": "...",
"plain": "..."}}""",
)

ENSEMBLER = RoleSpec(
    name="ensembler",
    alias="code",
    output=EnsemblerOut,
    max_tokens=1500,
    reasoning_effort="low",
    system=f"""You are the Ensembler of AutoTinker. Pick 2-4 kept solutions to combine and how: "soft_vote"
(average predictions, optional weights) or "stacking" (a simple meta-model on out-of-fold predictions).
Prefer diverse model families with good scores. The code is assembled for you.
{_PLAIN}
Reply with ONLY a JSON object: {{"strategy": "soft_vote", "members": ["e001", "e004"], "weights": null,
"rationale": "...", "plain": "..."}}""",
)

REPORTER = RoleSpec(
    name="reporter",
    alias="fast",
    output=ReporterOut,
    max_tokens=2000,
    system=f"""You are the Reporter of AutoTinker. Write the final report of an AutoML run for a non-expert,
using ONLY the facts given. Every number you quote must also appear in "numbers" under the SAME key as in
the facts (copy the values exactly; do not round in "numbers").
{_PLAIN}
Reply with ONLY a JSON object: {{"summary": "<3-5 sentences>", "what_worked": ["..."], "caveats": ["..."],
"next_steps": ["..."], "numbers": {{"best_cv": 0.0, "test_score": 0.0}}, "plain": "..."}}""",
)

ROLES: dict[str, RoleSpec[Any]] = {
    r.name: r for r in (INTAKE, PROFILER, PLANNER, CODER, DEBUGGER, CRITIC, TUNER, ENSEMBLER, REPORTER)
}


# ---------------------------------------------------------------- input builders


def intake_input(preview_csv: str, columns_summary: str, goal: str, hint_target: str | None) -> str:
    """preview_csv="" -> schema-only input (safe for providers that train on inputs)."""
    hint = f"\nThe user says the target column is {hint_target!r}." if hint_target else ""
    preview = f"\n\nPreview (header + first rows):\n{preview_csv}" if preview_csv else ""
    head = f"User's sentence: {goal.strip() or '(none)'}{hint}"
    return f"{head}\n\nColumns (code-computed):\n{columns_summary}{preview}"


def profiler_input(profile: DataProfile, goal: str, *, rows: bool = True) -> str:
    return f"Goal: {goal or '(not stated)'}\n\n{profile_text(profile, rows=rows)}"


def planner_input(
    *,
    profile: DataProfile,
    goal: str,
    risks: list[str],
    drop_columns: list[str],
    phase: str,
    ledger: str,
    best_id: str | None,
    best_code: str,
    best_cv: str,
    families_tried: list[str],
    ablation: str = "",
    instruction: str = "",
    constraints: list[str] | None = None,
) -> str:
    parts = [
        f"Goal: {goal or '(not stated)'}",
        *([constraints_text(constraints)] if constraints else []),
        profile_text(profile, rows=False),
        "Known risks: " + ("; ".join(risks)[:800] if risks else "none noted"),
        "Columns that must not be used: " + (", ".join(drop_columns) or "none"),
        f"Experiment history (do not repeat):\n{ledger}",
        f"Model families tried so far: {', '.join(families_tried) or 'none'}",
        f"Current best ({best_id or 'starter'}, {best_cv}):\n```python\n{excerpt(best_code)}\n```",
    ]
    if ablation:
        parts.append(f"Ablation of the best pipeline (CV change when a block is removed):\n{ablation}")
    parts.append(f"Phase: {phase}. {instruction}")
    return "\n\n".join(parts)


def coder_input(
    *,
    contract: str,
    profile: DataProfile,
    title: str,
    rationale: str,
    base_id: str,
    base_code: str,
    drop_columns: list[str],
) -> str:
    return "\n\n".join(
        [
            contract.strip(),
            profile_text(profile, rows=False),
            "Never use these columns as features: " + (", ".join(drop_columns) or "(none)"),
            f"Base solution ({base_id}):\n```python\n{excerpt(base_code)}\n```",
            f"Implement this ONE idea by editing the base solution:\n{title}\n{rationale}",
        ]
    )


def debugger_input(*, contract: str, title: str, code: str, error: str, profile: DataProfile) -> str:
    return "\n\n".join(
        [
            contract.strip(),
            f"Columns: {', '.join(c.name + ':' + c.kind.value for c in profile.columns)[:1500]}",
            f"Idea being implemented: {title}",
            f"solution.py that failed:\n```python\n{excerpt(code)}\n```",
            f"Error output (tail):\n```\n{tail(error)}\n```",
        ]
    )


def critic_input(
    *,
    profile: DataProfile,
    title: str,
    diff: str,
    scores: str,
    scan: list[str],
) -> str:
    return "\n\n".join(
        [
            profile_text(profile, rows=False),
            f"Experiment idea: {title}",
            f"Scores: {scores}",
            "Automatic leakage scan: " + ("; ".join(scan) if scan else "nothing found"),
            f"Change vs parent (unified diff):\n```diff\n{excerpt(diff, 5000)}\n```",
        ]
    )


def constraints_text(constraints: list[str]) -> str:
    """The steering messages of the person watching the run, as a prompt block."""
    lines = "\n".join(f"- {c}" for c in constraints)
    return f"User constraints (from the person watching the run; follow them):\n{lines}"


def tuner_input(
    *, profile: DataProfile, code: str, cv: str, budget_s: float, constraints: list[str] | None = None
) -> str:
    return "\n\n".join(
        [
            *([constraints_text(constraints)] if constraints else []),
            profile_text(profile, rows=False, max_cols=25),
            f"Best solution ({cv}):\n```python\n{excerpt(code)}\n```",
            f"Time budget for the whole search: about {budget_s:.0f} s; each trial runs a few CV folds.",
        ]
    )


def ensembler_input(*, profile: DataProfile, kept: list[dict[str, Any]]) -> str:
    rows = "\n".join(
        f"- {k['id']}: {k['title']} | family={k['family']} | cv={k['cv']:.5f}±{k['se']:.5f} "
        f"| fit_time={k['fit_time']}"
        for k in kept
    )
    return (
        f"problem={profile.problem_type.value} metric={profile.metric.value} (oriented, higher=better)\n"
        f"Candidate solutions (all valid, scored on the same folds):\n{rows}"
    )


def reporter_input(*, facts: dict[str, Any], experiments: list[str], stop_summary: str, goal: str) -> str:
    return "\n\n".join(
        [
            f"Goal: {goal or '(not stated)'}",
            "Facts (use these keys in numbers):\n" + json.dumps(facts, indent=1, default=str),
            "Experiments:\n" + "\n".join(experiments)[:5000],
            f"Why the run stopped: {stop_summary[:800]}",
        ]
    )
