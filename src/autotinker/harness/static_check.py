"""AST checks run on solution.py before it is executed. First line of defence; the sandbox is the second.

Errors block execution (ExecResult.error_kind == "static_check"); warnings are passed through to the agent.
"""

from __future__ import annotations

import ast
import functools
import importlib

BASE_ALLOWED_IMPORTS = frozenset(
    {
        "__future__",
        "sklearn",
        "numpy",
        "pandas",
        "scipy",
        "math",
        "statistics",
        "itertools",
        "functools",
        "collections",
        "re",
        "typing",
        "warnings",
        "dataclasses",
    }
)
OPTIONAL_IMPORTS = ("lightgbm", "xgboost", "catboost")

# Modules that get a specific message (they are all outside the allowlist anyway).
FORBIDDEN_MODULES = frozenset(
    {
        "os",
        "sys",
        "subprocess",
        "socket",
        "pathlib",
        "shutil",
        "pickle",
        "importlib",
        "ctypes",
        "builtins",
        "io",
        "signal",
        "resource",
        "multiprocessing",
        "threading",
        "urllib",
        "http",
        "requests",
        "joblib",
        "inspect",
        "gc",
    }
)
# Submodules of allowed packages that do file / network IO or native escapes.
FORBIDDEN_SUBMODULES = (
    "sklearn.datasets",
    "scipy.io",
    "pandas.io",
    "numpy.ctypeslib",
    "numpy.f2py",
    "numpy.lib.format",
)
FORBIDDEN_NAMES = frozenset(
    {
        "open",
        "exec",
        "eval",
        "compile",
        "__import__",
        "globals",
        "locals",
        "vars",
        "breakpoint",
        "input",
        "exit",
        "quit",
        "help",
        "__builtins__",
        "memoryview",
    }
)
# Attribute names whose mere access is forbidden (file IO / native escapes on allowed packages).
FORBIDDEN_ATTRS = frozenset(
    {"io", "ctypeslib", "f2py", "DataSource", "memmap", "open_memmap", "loadmat", "savemat", "system"}
)
# Attribute names that do file IO (blocked on any access, so they cannot be called or monkeypatched).
IO_CALLS = frozenset(
    {
        "load",
        "loads",
        "loadtxt",
        "genfromtxt",
        "fromfile",
        "tofile",
        "save",
        "savez",
        "savez_compressed",
        "savetxt",
        "to_csv",
        "to_pickle",
        "to_parquet",
        "to_json",
        "to_excel",
        "to_hdf",
        "to_feather",
        "to_sql",
        "to_clipboard",
        "to_stata",
        "to_orc",
        "to_xml",
        "to_html",
        "to_latex",
        "to_markdown",
    }
)
IO_CALL_PREFIXES = ("read_", "fetch_")
FIT_CALLS = frozenset({"fit", "fit_transform", "fit_predict", "partial_fit", "fit_resample"})
ALLOWED_DUNDER_ATTRS = frozenset({"__init__", "__sklearn_tags__"})
REFLECTION_CALLS = frozenset({"getattr", "setattr", "delattr", "hasattr"})


@functools.cache
def available_optional_imports() -> frozenset[str]:
    """Optional boosting libraries that actually import in this environment (probed once)."""
    ok = set()
    for name in OPTIONAL_IMPORTS:
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - e.g. lightgbm raises OSError when libomp is missing
            continue
        ok.add(name)
    return frozenset(ok)


def allowed_imports() -> frozenset[str]:
    return BASE_ALLOWED_IMPORTS | available_optional_imports()


def _dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__") and len(name) > 4


class _Checker(ast.NodeVisitor):
    def __init__(self, allowed: frozenset[str]) -> None:
        self.allowed = allowed
        self.errors: list[str] = []
        # Stack of enclosing scopes: "module", "class", "method" (def directly in a class), "function".
        self.scopes: list[str] = ["module"]

    def err(self, node: ast.AST, msg: str) -> None:
        self.errors.append(f"line {getattr(node, 'lineno', '?')}: {msg}")

    # -- imports -------------------------------------------------------------------------------
    def _check_module(self, node: ast.AST, module: str) -> None:
        root = module.split(".")[0]
        if root in FORBIDDEN_MODULES:
            self.err(
                node, f"import of '{module}' is forbidden (no file system, process, network or reflection)"
            )
        elif root not in self.allowed:
            self.err(node, f"import of '{module}' is not allowed; allowed: {', '.join(sorted(self.allowed))}")
        elif any(module == s or module.startswith(s + ".") for s in FORBIDDEN_SUBMODULES):
            self.err(node, f"import of '{module}' is forbidden (it does file or network IO)")

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._check_module(node, alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level:
            self.err(node, "relative imports are not allowed")
            return
        module = node.module or ""
        self._check_module(node, module)
        for alias in node.names:
            if alias.name == "*":
                self.err(node, "'from ... import *' is not allowed")
            elif f"{module}.{alias.name}" in FORBIDDEN_SUBMODULES:
                self.err(node, f"import of '{module}.{alias.name}' is forbidden (it does file or network IO)")
            elif (
                alias.name in FORBIDDEN_NAMES
                or alias.name in FORBIDDEN_ATTRS
                or alias.name in IO_CALLS
                or alias.name.startswith(IO_CALL_PREFIXES)
            ):
                self.err(node, f"importing '{alias.name}' is forbidden (file IO / reflection)")

    # -- scopes --------------------------------------------------------------------------------
    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for d in node.decorator_list + node.bases + [k.value for k in node.keywords]:
            self.visit(d)
        self.scopes.append("class")
        for stmt in node.body:
            self.visit(stmt)
        self.scopes.pop()

    def _visit_func(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if isinstance(node, ast.AsyncFunctionDef):
            self.err(node, "async functions are not allowed")
        for d in node.decorator_list:
            self.visit(d)
        self.visit(node.args)
        if node.returns:
            self.visit(node.returns)
        inside_method = "method" in self.scopes
        self.scopes.append("method" if self.scopes[-1] == "class" or inside_method else "function")
        for stmt in node.body:
            self.visit(stmt)
        self.scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_func(node)

    # -- names, attributes, calls --------------------------------------------------------------
    def visit_Name(self, node: ast.Name) -> None:
        if node.id in FORBIDDEN_NAMES or _dunder(node.id) and node.id not in ("__name__",):
            self.err(node, f"use of '{node.id}' is forbidden")
        elif node.id in REFLECTION_CALLS:
            # Reached only when not called directly (see visit_Call), e.g. `g = getattr` or
            # `reduce(getattr, ...)`, which would bypass the literal-name check.
            self.err(node, f"'{node.id}' must be called directly with a literal attribute name")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if _dunder(node.attr) and node.attr not in ALLOWED_DUNDER_ATTRS:
            self.err(node, f"access to dunder attribute '.{node.attr}' is forbidden")
        elif node.attr in FORBIDDEN_ATTRS:
            self.err(node, f"access to '.{node.attr}' is forbidden (file IO / native code)")
        elif node.attr in IO_CALLS or node.attr.startswith(IO_CALL_PREFIXES):
            self.err(
                node,
                f"'.{node.attr}' is file/network IO, which is forbidden; "
                "the harness provides the data to your pipeline",
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Name) and func.id in REFLECTION_CALLS and len(node.args) >= 2:
            attr = node.args[1]
            if not (isinstance(attr, ast.Constant) and isinstance(attr.value, str)):
                self.err(node, f"{func.id}() needs a literal attribute name")
            elif _dunder(attr.value):
                self.err(node, f"{func.id}() on dunder attribute '{attr.value}' is forbidden")
        if isinstance(func, ast.Name) and func.id in REFLECTION_CALLS:
            for child in [*node.args, *node.keywords]:
                self.visit(child)
            return
        if isinstance(func, ast.Attribute):
            name = func.attr
            if name in FIT_CALLS and "method" not in self.scopes:
                where = "at module level" if self.scopes == ["module"] else "inside build_pipeline/helpers"
                self.err(
                    node,
                    f"'.{name}(...)' called {where}: return an UNFITTED estimator, the harness does all "
                    "fitting (fitting here would leak data across folds). Fitting is only allowed inside "
                    "methods of a custom estimator class.",
                )
        self.generic_visit(node)


def static_check(code: str, allowed: frozenset[str] | None = None) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) for a candidate solution.py."""
    allowed = allowed if allowed is not None else allowed_imports()
    warnings: list[str] = []
    try:
        tree = ast.parse(code, filename="solution.py")
    except SyntaxError as e:
        return [f"line {e.lineno}: syntax error: {e.msg}"], warnings

    checker = _Checker(allowed)
    checker.visit(tree)
    errors = checker.errors

    funcs = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    bp = funcs.get("build_pipeline")
    if bp is None:
        errors.append("solution must define a top-level function `build_pipeline(profile: dict)`")
    else:
        n_pos = len(bp.args.posonlyargs) + len(bp.args.args)
        if n_pos < 1 and bp.args.vararg is None:
            errors.append("`build_pipeline` must accept one positional argument: the profile dict")
    if "engineer_features" in funcs:
        warnings.append(
            "`engineer_features` is not called by the harness; put feature engineering inside the pipeline "
            "(e.g. a FunctionTransformer or a custom transformer)"
        )
    for stmt in tree.body:
        if isinstance(stmt, ast.While | ast.For):
            warnings.append(
                f"line {stmt.lineno}: top-level loop runs at import time; keep work in build_pipeline"
            )
    n_lines = len(code.splitlines())
    if n_lines > 400:
        warnings.append(f"solution is long ({n_lines} lines); simpler solutions are preferred")
    return errors, warnings
