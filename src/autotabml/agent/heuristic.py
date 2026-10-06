"""HeuristicProposer: an OFFLINE proposer (no LLM, no API key) for demos, tests and ablations.

A solution is represented as a small structured spec (model family, hyperparameters, preprocessing and
feature-engineering flags, optional ensemble members) that is *rendered* into a readable solution.py.
The spec is embedded in the code as a `# autotabml-spec: {...}` comment so the current best can be mutated
again. Code without a spec (the harness starter, LLM-written code) starts from the default spec.

Ideas come from a fixed bank: hyperparameter steps, preprocessing / encoding / scaling changes, simple
feature engineering, model-family switches and soft-voting / stacking ensembles of the top kept solutions
(both marked radical), and simplifications. Choices are deterministic given (seed, experiment index).
"""

from __future__ import annotations

import copy
import json
import random
from typing import Any

from autotabml.agent.context import Proposal, ProposalContext, RepairResult
from autotabml.contracts import Idea, IdeaCategory, ProblemType

SPEC_PREFIX = "# autotabml-spec: "

FAMILIES = ("hgb", "rf", "et", "gb", "linear")
FAMILY_NAMES = {
    "hgb": "HistGradientBoosting",
    "rf": "RandomForest",
    "et": "ExtraTrees",
    "gb": "GradientBoosting",
    "linear": "linear model",
}

DEFAULT_PARAMS: dict[str, dict[str, Any]] = {
    "hgb": {
        "learning_rate": 0.1,
        "max_iter": 100,
        "max_leaf_nodes": 31,
        "l2_regularization": 0.0,
        "min_samples_leaf": 20,
        "max_depth": None,
    },
    "rf": {"n_estimators": 300, "min_samples_leaf": 1, "max_features": "sqrt", "max_depth": None},
    "et": {"n_estimators": 300, "min_samples_leaf": 1, "max_features": "sqrt", "max_depth": None},
    "gb": {"n_estimators": 150, "learning_rate": 0.1, "max_depth": 3, "subsample": 1.0},
    "linear": {"C": 1.0, "alpha": 1.0},
}

GRIDS: dict[str, dict[str, list[Any]]] = {
    "hgb": {
        "learning_rate": [0.02, 0.05, 0.1, 0.2],
        "max_iter": [50, 100, 200, 400],
        "max_leaf_nodes": [7, 15, 31, 63],
        "l2_regularization": [0.0, 0.1, 1.0, 10.0],
        "min_samples_leaf": [5, 10, 20, 40],
        "max_depth": [None, 3, 6],
    },
    "rf": {
        "n_estimators": [150, 300, 600],
        "min_samples_leaf": [1, 2, 5, 10],
        "max_features": ["sqrt", 0.5, 1.0],
        "max_depth": [None, 6, 12],
    },
    "et": {
        "n_estimators": [150, 300, 600],
        "min_samples_leaf": [1, 2, 5, 10],
        "max_features": ["sqrt", 0.5, 1.0],
        "max_depth": [None, 6, 12],
    },
    "gb": {
        "n_estimators": [75, 150, 300],
        "learning_rate": [0.03, 0.05, 0.1, 0.2],
        "max_depth": [2, 3, 4, 5],
        "subsample": [0.7, 0.85, 1.0],
    },
    "linear": {"C": [0.03, 0.1, 0.3, 1.0, 3.0, 10.0], "alpha": [0.1, 0.3, 1.0, 3.0, 10.0, 30.0]},
}

FE_NAMES = {"log1p": "signed log1p transform of numeric features", "row_stats": "row mean/std features"}


def default_spec() -> dict[str, Any]:
    return {
        "model": "hgb",
        "params": dict(DEFAULT_PARAMS["hgb"]),
        "impute": "median",
        "scale": "none",
        "cat": "onehot",
        "fe": [],
    }


def spec_key(spec: dict[str, Any]) -> str:
    return json.dumps(spec, sort_keys=True, default=str)


def parse_spec(code: str) -> dict[str, Any] | None:
    for line in code.splitlines():
        if line.startswith(SPEC_PREFIX):
            try:
                obj = json.loads(line[len(SPEC_PREFIX) :])
            except json.JSONDecodeError:
                return None
            return obj if isinstance(obj, dict) and "model" in obj else None
    return None


# ---------------------------------------------------------------- rendering


def _relevant_params(model: str, params: dict[str, Any], problem: ProblemType) -> dict[str, Any]:
    p = dict(params)
    if model == "linear":
        return {"C": p.get("C", 1.0)} if problem != ProblemType.regression else {"alpha": p.get("alpha", 1.0)}
    if model in ("rf", "et") and problem == ProblemType.regression and p.get("max_features") == "sqrt":
        p["max_features"] = 1.0
    return p


def _estimator_expr(model: str, params: dict[str, Any], problem: ProblemType) -> tuple[str, str, str]:
    """-> (import module, class name, constructor expression)."""
    clf = problem != ProblemType.regression
    p = _relevant_params(model, params, problem)
    if model == "hgb":
        mod, cls = (
            "sklearn.ensemble",
            "HistGradientBoostingClassifier" if clf else "HistGradientBoostingRegressor",
        )
        p["random_state"] = 0
    elif model == "rf":
        mod, cls = "sklearn.ensemble", "RandomForestClassifier" if clf else "RandomForestRegressor"
        p["random_state"] = 0
    elif model == "et":
        mod, cls = "sklearn.ensemble", "ExtraTreesClassifier" if clf else "ExtraTreesRegressor"
        p["random_state"] = 0
    elif model == "gb":
        mod, cls = "sklearn.ensemble", "GradientBoostingClassifier" if clf else "GradientBoostingRegressor"
        p["random_state"] = 0
    elif model == "linear":
        mod = "sklearn.linear_model"
        if clf:
            cls = "LogisticRegression"
            p["max_iter"] = 2000
        else:
            cls = "Ridge"
    else:
        raise ValueError(f"unknown model family {model!r}")
    args = ", ".join(f"{k}={v!r}" for k, v in p.items())
    return mod, cls, f"{cls}({args})"


def _effective_scale(spec: dict[str, Any]) -> str:
    scale = str(spec.get("scale", "none"))
    if spec["model"] == "linear" and scale == "none":
        return "standard"  # linear models always need scaling
    return scale


def _member_expr(spec: dict[str, Any], problem: ProblemType, imports: dict[str, set[str]]) -> str:
    mod, cls, expr = _estimator_expr(spec["model"], spec.get("params", {}), problem)
    imports.setdefault(mod, set()).add(cls)
    fe = tuple(spec.get("fe", []))
    prep = (
        f"_preprocessor(profile, impute={spec.get('impute', 'median')!r}, scale={_effective_scale(spec)!r}, "
        f"cat={spec.get('cat', 'onehot')!r}, fe={fe!r})"
    )
    return f'Pipeline([\n    ("prep", {prep}),\n    ("model", {expr}),\n])'


_HEADER = '''"""solution.py - generated by AutoTabML's offline heuristic proposer.

Idea: {title}
build_pipeline(profile) returns an UNFITTED sklearn estimator that takes the raw feature DataFrame;
all preprocessing lives inside the pipeline. The harness does all fitting and scoring.
"""
'''

_HELPERS = """
NUMERIC_KINDS = ("numeric",)
CATEGORICAL_KINDS = ("categorical", "boolean", "text")


def _as_str(X):
    return X.astype(str)


def _signed_log1p(X):
    X = np.asarray(X, dtype=float)
    return np.sign(X) * np.log1p(np.abs(X))


def _row_stats(X):
    X = np.asarray(X, dtype=float)
    return np.column_stack([X, X.mean(axis=1), X.std(axis=1)])


def _split_columns(profile):
    numeric = [c["name"] for c in profile["columns"] if c["kind"] in NUMERIC_KINDS]
    categorical = [c["name"] for c in profile["columns"] if c["kind"] in CATEGORICAL_KINDS]
    return numeric, categorical


def _preprocessor(profile, impute="median", scale="none", cat="onehot", fe=()):
    numeric, categorical = _split_columns(profile)
    num_steps = [("impute", SimpleImputer(strategy=impute))]
    if "log1p" in fe:
        num_steps.append(("log1p", FunctionTransformer(_signed_log1p)))
    if "row_stats" in fe:
        num_steps.append(("row_stats", FunctionTransformer(_row_stats)))
    if scale == "standard":
        num_steps.append(("scale", StandardScaler()))
    elif scale == "power":
        num_steps.append(("scale", PowerTransformer()))
    if cat == "ordinal":
        encoder = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)
    else:
        encoder = OneHotEncoder(handle_unknown="ignore", max_categories=20, sparse_output=False)
    cat_steps = [("to_str", FunctionTransformer(_as_str)), ("encode", encoder)]
    transformers = []
    if numeric:
        transformers.append(("num", Pipeline(num_steps), numeric))
    if categorical:
        transformers.append(("cat", Pipeline(cat_steps), categorical))
    return ColumnTransformer(transformers, remainder="drop", sparse_threshold=0.0)
"""


def render(spec: dict[str, Any], problem: ProblemType, title: str = "") -> str:
    imports: dict[str, set[str]] = {
        "sklearn.compose": {"ColumnTransformer"},
        "sklearn.impute": {"SimpleImputer"},
        "sklearn.pipeline": {"Pipeline"},
        "sklearn.preprocessing": {
            "FunctionTransformer",
            "OneHotEncoder",
            "OrdinalEncoder",
            "PowerTransformer",
            "StandardScaler",
        },
    }
    members = spec.get("members")
    if members:
        clf = problem != ProblemType.regression
        parts = [
            f'("m{i}", {_member_expr(m, problem, imports)})'.replace("\n", "\n        ")
            for i, m in enumerate(members)
        ]
        joined = ",\n        ".join(parts)
        if spec.get("ens") == "stack":
            ens_cls = "StackingClassifier" if clf else "StackingRegressor"
            final = "LogisticRegression(max_iter=2000)" if clf else "RidgeCV()"
            imports.setdefault("sklearn.linear_model", set()).add("LogisticRegression" if clf else "RidgeCV")
            if clf:
                cv = "3"
            else:  # shuffled folds: the rows handed to fit may still be ordered by the target
                cv = "KFold(n_splits=3, shuffle=True, random_state=0)"
                imports.setdefault("sklearn.model_selection", set()).add("KFold")
            body = (
                f"{ens_cls}(\n    estimators=[\n        {joined},\n    ],\n"
                f"    final_estimator={final},\n    cv={cv},\n)"
            )
        else:
            ens_cls = "VotingClassifier" if clf else "VotingRegressor"
            voting = ', voting="soft"' if clf else ""
            body = f"{ens_cls}(\n    estimators=[\n        {joined},\n    ]{voting},\n)"
        imports.setdefault("sklearn.ensemble", set()).add(ens_cls)
        build = f"    return {body.replace(chr(10), chr(10) + '    ')}\n"
    else:
        build = f"    return {_member_expr(spec, problem, imports).replace(chr(10), chr(10) + '    ')}\n"
    import_lines = ["import numpy as np", ""]
    for mod in sorted(imports):
        import_lines.append(f"from {mod} import {', '.join(sorted(imports[mod]))}")
    return (
        _HEADER.format(title=title or "baseline")
        + SPEC_PREFIX
        + json.dumps(spec, sort_keys=True)
        + "\n"
        + "\n".join(import_lines)
        + "\n"
        + _HELPERS
        + "\n\ndef build_pipeline(profile):\n"
        + build
    )


# ---------------------------------------------------------------- idea bank


def _fmt(v: Any) -> str:
    return "None" if v is None else str(v)


def _hyper_ideas(spec: dict[str, Any], problem: ProblemType) -> list[tuple[Idea, dict[str, Any]]]:
    out: list[tuple[Idea, dict[str, Any]]] = []
    model = spec["model"]
    grid = GRIDS[model]
    keys = list(grid)
    if model == "linear":
        keys = ["alpha"] if problem == ProblemType.regression else ["C"]
    for k in keys:
        values = grid[k]
        cur = spec["params"].get(k, DEFAULT_PARAMS[model].get(k))
        idx = values.index(cur) if cur in values else None
        neighbours = (
            values if idx is None else [values[j] for j in (idx - 1, idx + 1) if 0 <= j < len(values)]
        )
        for v in neighbours:
            if v == cur:
                continue
            new = copy.deepcopy(spec)
            new["params"][k] = v
            title = f"{FAMILY_NAMES[model]}: set {k} {_fmt(cur)} -> {_fmt(v)}"
            out.append(
                (
                    Idea(
                        title=title,
                        rationale=f"tune {k} one grid step",
                        category=IdeaCategory.hyperparameters,
                    ),
                    new,
                )
            )
    return out


def _prep_ideas(spec: dict[str, Any]) -> list[tuple[Idea, dict[str, Any]]]:
    out: list[tuple[Idea, dict[str, Any]]] = []

    def add(title: str, why: str, category: IdeaCategory, **changes: Any) -> None:
        new = copy.deepcopy(spec)
        new.update(changes)
        out.append((Idea(title=title, rationale=why, category=category), new))

    other_imp = "mean" if spec.get("impute") == "median" else "median"
    add(
        f"Impute numeric missing values with the {other_imp} instead",
        "robustness to skew/outliers",
        IdeaCategory.preprocessing,
        impute=other_imp,
    )
    for scale in ("none", "standard", "power"):
        if scale != spec.get("scale") and not (spec["model"] == "linear" and scale == "none"):
            add(
                f"Numeric scaling: {spec.get('scale')} -> {scale}",
                "change the numeric feature scale",
                IdeaCategory.preprocessing,
                scale=scale,
            )
    other_cat = "ordinal" if spec.get("cat") == "onehot" else "onehot"
    add(
        f"Encode categoricals with {other_cat} encoding",
        "a different categorical representation",
        IdeaCategory.preprocessing,
        cat=other_cat,
    )
    for fe, desc in FE_NAMES.items():
        if fe not in spec.get("fe", []):
            add(
                f"Feature engineering: add {desc}",
                "give the model a transformed view of the numeric features",
                IdeaCategory.feature_engineering,
                fe=sorted([*spec.get("fe", []), fe]),
            )
    return out


def _simplify_ideas(spec: dict[str, Any]) -> list[tuple[Idea, dict[str, Any]]]:
    out: list[tuple[Idea, dict[str, Any]]] = []
    if spec.get("members"):
        first = copy.deepcopy(spec["members"][0])
        out.append(
            (
                Idea(
                    title=f"Simplify: drop the ensemble, keep only its {FAMILY_NAMES[first['model']]} member",
                    rationale="fewer moving parts",
                    category=IdeaCategory.simplification,
                ),
                first,
            )
        )
        return out
    if spec.get("fe"):
        new = copy.deepcopy(spec)
        new["fe"] = []
        out.append(
            (
                Idea(
                    title="Simplify: remove engineered features",
                    rationale="less code",
                    category=IdeaCategory.simplification,
                ),
                new,
            )
        )
    if spec["model"] != "linear" and spec.get("scale") != "none":
        new = copy.deepcopy(spec)
        new["scale"] = "none"
        out.append(
            (
                Idea(
                    title="Simplify: drop numeric scaling for a tree model",
                    rationale="trees are scale-free",
                    category=IdeaCategory.simplification,
                ),
                new,
            )
        )
    if spec["params"] != DEFAULT_PARAMS[spec["model"]]:
        new = copy.deepcopy(spec)
        new["params"] = dict(DEFAULT_PARAMS[spec["model"]])
        out.append(
            (
                Idea(
                    title=f"Simplify: reset {FAMILY_NAMES[spec['model']]} hyperparameters to defaults",
                    rationale="defaults are often near-optimal",
                    category=IdeaCategory.simplification,
                ),
                new,
            )
        )
    return out


def _family_ideas(spec: dict[str, Any]) -> list[tuple[Idea, dict[str, Any]]]:
    out: list[tuple[Idea, dict[str, Any]]] = []
    base = spec["members"][0] if spec.get("members") else spec
    for fam in FAMILIES:
        if fam == base["model"] and not spec.get("members"):
            continue
        new = {k: copy.deepcopy(v) for k, v in base.items() if k not in ("members", "ens")}
        new["model"] = fam
        new["params"] = dict(DEFAULT_PARAMS[fam])
        if fam == "linear" and new.get("scale") == "none":
            new["scale"] = "standard"
        title = f"Switch model family: {FAMILY_NAMES[base['model']]} -> {FAMILY_NAMES[fam]}"
        out.append(
            (
                Idea(
                    title=title,
                    rationale="escape a local optimum with a different inductive bias",
                    category=IdeaCategory.model_family,
                    radical=True,
                ),
                new,
            )
        )
    return out


def _ensemble_ideas(spec: dict[str, Any], ctx: ProposalContext) -> list[tuple[Idea, dict[str, Any]]]:
    members: list[dict[str, Any]] = []
    ids: list[str] = []
    seen: set[str] = set()
    for k in ctx.kept:  # best first
        s = parse_spec(k.code) or default_spec()
        for m in s.get("members") or [s]:
            key = spec_key(m)
            if key not in seen:
                seen.add(key)
                members.append(m)
                ids.append(k.exp_id)
    if not members:
        members, ids = [spec], [ctx.best_exp_id or "best"]
    members = sorted(members[:3], key=spec_key)  # canonical order, so the same blend is never retried
    label = ", ".join(dict.fromkeys(ids[: len(members)]))
    fams = {m["model"] for m in members}
    for fam in ("et", "rf", "linear", "hgb"):
        if len(members) >= 3:
            break
        if fam not in fams:
            extra: dict[str, Any] = {
                "model": fam,
                "params": dict(DEFAULT_PARAMS[fam]),
                "impute": "median",
                "scale": "standard" if fam == "linear" else "none",
                "cat": "onehot",
                "fe": [],
            }
            members.append(extra)
            fams.add(fam)
            label += f" + {FAMILY_NAMES[fam]}"
    out = []
    for ens, what in (("vote", "Soft-voting"), ("stack", "Stacking")):
        new = {"model": "ensemble", "ens": ens, "members": copy.deepcopy(members), "params": {}}
        out.append(
            (
                Idea(
                    title=f"{what} ensemble of top kept solutions ({label})",
                    rationale="blend diverse strong models; often the last gains on tabular data",
                    category=IdeaCategory.ensembling,
                    radical=True,
                ),
                new,
            )
        )
    return out


class HeuristicProposer:
    """Deterministic offline proposer. Label: "heuristic"."""

    label = "heuristic"

    def __init__(self, seed: int = 0, patience: int = 3, radical_rate: float = 0.15) -> None:
        self.seed = seed
        self.patience = patience
        self.radical_rate = radical_rate
        self.tried: set[str] = set()

    def _problem(self, ctx: ProposalContext) -> ProblemType:
        return ctx.profile.problem_type

    def _current_spec(self, ctx: ProposalContext) -> dict[str, Any]:
        spec = parse_spec(ctx.best_code) if ctx.best_code else None
        spec = spec or default_spec()
        self.tried.add(spec_key(spec))
        return spec

    def draft(self, ctx: ProposalContext) -> Proposal:
        spec = default_spec()
        if ctx.profile.n_rows < 300:  # small data: smaller leaves
            spec["params"]["min_samples_leaf"] = 10
        self.tried.add(spec_key(spec))
        idea = Idea(
            title="Draft: impute + one-hot encode, HistGradientBoosting",
            rationale="a strong, robust default for mixed tabular data",
            category=IdeaCategory.model_family,
        )
        return Proposal(idea, render(spec, self._problem(ctx), idea.title))

    def candidates(self, ctx: ProposalContext) -> dict[str, list[tuple[Idea, dict[str, Any]]]]:
        spec = self._current_spec(ctx)
        problem = self._problem(ctx)
        if spec.get("members"):
            pools = {"hyperparameters": [], "preprocessing": [], "simplification": _simplify_ideas(spec)}
        else:
            pools = {
                "hyperparameters": _hyper_ideas(spec, problem),
                "preprocessing": _prep_ideas(spec),
                "simplification": _simplify_ideas(spec),
            }
        pools["radical"] = _family_ideas(spec) + _ensemble_ideas(spec, ctx)
        return {k: [(i, s) for i, s in v if spec_key(s) not in self.tried] for k, v in pools.items()}

    def propose_and_implement(self, ctx: ProposalContext) -> Proposal:
        rng = random.Random(self.seed * 1_000_003 + ctx.exp_index)
        pools = self.candidates(ctx)
        stalled = ctx.since_last_keep >= self.patience
        go_radical = rng.random() < (0.6 if stalled else self.radical_rate)
        order = (
            ["radical", "hyperparameters", "preprocessing", "simplification"]
            if go_radical
            else rng.choices(
                [
                    ["hyperparameters", "preprocessing", "simplification", "radical"],
                    ["preprocessing", "hyperparameters", "simplification", "radical"],
                    ["simplification", "hyperparameters", "preprocessing", "radical"],
                ],
                weights=[0.6, 0.3, 0.1],
            )[0]
        )
        for name in order:
            if pools[name]:
                idea, spec = rng.choice(pools[name])
                break
        else:  # idea bank exhausted: random restart of hyperparameters around the default spec
            spec = default_spec()
            for k, values in GRIDS["hgb"].items():
                spec["params"][k] = rng.choice(values)
            idea = Idea(
                title=f"Random HistGradientBoosting configuration #{ctx.exp_index}",
                rationale="idea bank exhausted",
                category=IdeaCategory.hyperparameters,
                radical=True,
            )
        self.tried.add(spec_key(spec))
        return Proposal(idea, render(spec, self._problem(ctx), idea.title))

    def repair(self, ctx: ProposalContext, code: str, error_tail: str) -> RepairResult:
        """No LLM to debug with: fall back to a simpler variant of the failing spec."""
        spec = parse_spec(code)
        if spec and spec.get("members"):
            new = spec["members"][0]
            note = "dropped the ensemble"
        elif spec and (spec.get("fe") or spec.get("scale") == "power"):
            new = {**spec, "fe": [], "scale": "standard" if spec["model"] == "linear" else "none"}
            note = "removed feature engineering / power scaling"
        else:
            new = default_spec()
            note = "reverted to the default pipeline"
        return RepairResult(render(new, self._problem(ctx), f"repair: {note}"), [], note)
