"""Deterministic code transforms used by the agentic loop ("the LLM decides what, code does the work").

* `with_params`        bake tuned hyperparameters into a solution via a `set_params` wrapper
* `ablation_variants`  one variant per named pipeline block, with that block switched off
* `ensemble_code`      merge several kept solutions into one soft-voting / stacking solution.py
* `leakage_scan`       cheap static signals of leakage for the Critic (target name, flagged columns)

Every generated file is ordinary solution.py code: it goes through the harness's static check and sandbox
like anything an agent writes.
"""

from __future__ import annotations

import ast
import pprint
import re

from autotinker.contracts import DataProfile


def without_columns(code: str, columns: list[str]) -> str:
    """Hide `columns` (IDs / leaks named by the Profiler) from a solution that selects its features from
    profile["columns"], as the starter does."""
    if not columns:
        return code
    return (
        code.rstrip()
        + "\n\n\n# ---- columns the Profiler ruled out (IDs / leakage), hidden from the pipeline ----\n"
        + f"DROP_COLUMNS = {sorted(columns)!r}\n"
        + "_build_all_columns = build_pipeline\n\n\n"
        + "def build_pipeline(profile):\n"
        + "    profile = dict(profile)\n"
        + '    profile["columns"] = [c for c in profile["columns"] if c["name"] not in DROP_COLUMNS]\n'
        + "    return _build_all_columns(profile)\n"
    )


FINAL_STEP_NAMES = frozenset({"model", "clf", "classifier", "regressor", "estimator", "est", "final"})
_STEP_NAME = re.compile(r"\(\s*[\"']([A-Za-z_]\w{0,40})[\"']\s*,")


def with_params(code: str, params: dict[str, object]) -> str:
    """Append a wrapper that applies `params` (sklearn set_params paths) to the built pipeline."""
    lit = pprint.pformat(dict(sorted(params.items())), indent=4, width=100, sort_dicts=True)
    return (
        code.rstrip()
        + "\n\n\n# ---- tuned hyperparameters (found by Optuna inside the sandbox) ----\n"
        + f"TUNED_PARAMS = {lit}\n"
        + "_build_untuned = build_pipeline\n\n\n"
        + "def build_pipeline(profile):\n"
        + "    est = _build_untuned(profile)\n"
        + "    est.set_params(**TUNED_PARAMS)\n"
        + "    return est\n"
    )


def block_names(code: str, limit: int = 5) -> list[str]:
    """Named steps of Pipelines / ColumnTransformers / FeatureUnions, in order, excluding the final model."""
    seen: list[str] = []
    for m in _STEP_NAME.finditer(code):
        n = m.group(1)
        if n not in seen and n.lower() not in FINAL_STEP_NAMES:
            seen.append(n)
    return seen[:limit]


_ABLATE_HELPER = """

# ---- ablation wrapper (generated): switch off one named block ----
def _ablate_block(est, name):
    steps = getattr(est, "steps", None)
    if isinstance(steps, list):
        for i, item in enumerate(steps):
            if item[0] == name and i < len(steps) - 1:
                steps[i] = (item[0], "passthrough")
                return True
            if _ablate_block(item[1], name):
                return True
    trs = getattr(est, "transformers", None)
    if isinstance(trs, list):
        for i, item in enumerate(trs):
            if item[0] == name:
                trs[i] = (item[0], "drop", item[2])
                return True
            if _ablate_block(item[1], name):
                return True
    parts = getattr(est, "transformer_list", None)
    if isinstance(parts, list):
        for i, item in enumerate(parts):
            if item[0] == name:
                parts[i] = (item[0], "drop")
                return True
            if _ablate_block(item[1], name):
                return True
    return False


_build_full = build_pipeline


def build_pipeline(profile):
    est = _build_full(profile)
    if not _ablate_block(est, ABLATED_BLOCK):
        raise ValueError("ablation: block " + ABLATED_BLOCK + " not found")
    return est
"""


def ablation_variants(code: str, limit: int = 4) -> list[tuple[str, str]]:
    return [
        (name, code.rstrip() + f"\n\n\nABLATED_BLOCK = {name!r}\n" + _ABLATE_HELPER)
        for name in block_names(code, limit)
    ]


# ---------------------------------------------------------------- ensembles


class _Renamer(ast.NodeTransformer):
    def __init__(self, names: set[str], suffix: str) -> None:
        self.names = names
        self.suffix = suffix

    def _r(self, n: str) -> str:
        return f"{n}{self.suffix}" if n in self.names else n

    def visit_Name(self, node: ast.Name) -> ast.AST:
        node.id = self._r(node.id)
        return node

    def visit_arg(self, node: ast.arg) -> ast.AST:
        node.arg = self._r(node.arg)
        self.generic_visit(node)
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        node.name = self._r(node.name)
        self.generic_visit(node)
        return node

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.AST:
        node.name = self._r(node.name)
        self.generic_visit(node)
        return node


def _top_level_names(tree: ast.Module) -> set[str]:
    out: set[str] = set()
    for st in tree.body:
        if isinstance(st, ast.FunctionDef | ast.ClassDef):
            out.add(st.name)
        elif isinstance(st, ast.Assign):
            for t in st.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        out.add(n.id)
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
            out.add(st.target.id)
    return out


def namespaced(code: str, suffix: str) -> tuple[str, bool]:
    """Rename every top-level definition of `code` with `suffix`. Returns (code, had_future_import)."""
    tree = ast.parse(code)
    future = False
    body: list[ast.stmt] = []
    for st in tree.body:
        if isinstance(st, ast.ImportFrom) and st.module == "__future__":
            future = True
            continue
        if (
            isinstance(st, ast.Expr)
            and isinstance(st.value, ast.Constant)
            and isinstance(st.value.value, str)
            and not body
        ):
            continue  # module docstring
        body.append(st)
    tree.body = body
    new = _Renamer(_top_level_names(tree), suffix).visit(tree)
    ast.fix_missing_locations(new)
    return ast.unparse(new), future


def ensemble_code(
    members: list[tuple[str, str]],
    *,
    strategy: str = "soft_vote",
    weights: list[float] | None = None,
) -> str:
    """members: [(exp_id, code)]. The result defines build_pipeline(profile) returning a voting/stacking
    estimator over each member's own pipeline."""
    parts: list[str] = []
    any_future = False
    entries: list[str] = []
    for exp_id, code in members:
        suffix = "_" + re.sub(r"\W", "_", exp_id)
        body, fut = namespaced(code, suffix)
        any_future = any_future or fut
        parts.append(f"# ---- member {exp_id} ----\n{body}\n")
        entries.append(f'        ("{exp_id}", build_pipeline{suffix}(profile)),')
    w = None
    if weights and len(weights) == len(members) and all(x >= 0 for x in weights) and sum(weights) > 0:
        w = [float(x) for x in weights]
    header = '"""Ensemble of kept solutions: ' + ", ".join(m for m, _ in members) + ' (generated)."""\n'
    if any_future:
        header += "from __future__ import annotations\n"
    header += (
        "from sklearn.ensemble import (\n"
        "    StackingClassifier, StackingRegressor, VotingClassifier, VotingRegressor\n"
        ")\n"
        "from sklearn.linear_model import LogisticRegression, RidgeCV\n\n"
    )
    members_block = "    members = [\n" + "\n".join(entries) + "\n    ]\n"
    if strategy == "stacking":
        tail = (
            "\n\ndef build_pipeline(profile):\n"
            + members_block
            + '    if profile["problem_type"] == "regression":\n'
            + "        return StackingRegressor(members, final_estimator=RidgeCV(), cv=3)\n"
            + "    return StackingClassifier(\n"
            + "        members, final_estimator=LogisticRegression(max_iter=2000), cv=3, "
            + 'stack_method="predict_proba"\n'
            + "    )\n"
        )
    else:
        tail = (
            "\n\ndef build_pipeline(profile):\n"
            + members_block
            + f"    weights = {w!r}\n"
            + '    if profile["problem_type"] == "regression":\n'
            + "        return VotingRegressor(members, weights=weights)\n"
            + '    return VotingClassifier(members, voting="soft", weights=weights)\n'
        )
    return header + "\n\n".join(parts) + tail


# ---------------------------------------------------------------- leakage scan


def leakage_scan(code: str, profile: DataProfile) -> list[str]:
    """Static leakage signals (no execution). Empty list = nothing found."""
    out: list[str] = []
    strings: set[str] = set()
    try:
        for n in ast.walk(ast.parse(code)):
            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                strings.add(n.value)
    except SyntaxError:
        return out
    if profile.target in strings:
        out.append(f"the code mentions the target column {profile.target!r} by name")
    for c in profile.columns:
        risky = [f for f in c.flags if "leak" in f or "id" in f]
        if risky and c.name in strings:
            out.append(f"the code uses column {c.name!r}, flagged {','.join(risky)}")
    if re.search(r"\.shift\(|\.rolling\(|\.expanding\(", code):
        out.append("the code uses row-order operations (shift/rolling/expanding)")
    return out
