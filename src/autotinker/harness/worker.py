"""Sandbox worker: `python -m autotinker.harness.worker <job.json>`.

Runs in a fresh subprocess with a scrubbed environment and a temp cwd (see sandbox.py). It blocks network
access *before* any solution code is imported, loads only the worker-visible split data, fits the solution
and writes raw predictions (`preds.npz`) plus a status file (`result.json`). Scoring happens in the parent.

Modes:
  cv    for each fixed fold: fit on dev-train, predict dev-val; then fit on all of dev, predict select
  test  fit on dev+select, predict test
  tune  Optuna search over `set_params` paths (job["space"]) on the first job["tune_folds"] fixed dev folds;
        trial scores are computed here (they only steer the search). The tuned solution is then scored by
        the parent like any other through a normal `cv` run.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import pickle
import random
import socket
import sys
import time
import traceback
from typing import Any, NoReturn

import numpy as np

NETWORK_BLOCKED_MSG = "network access is blocked in the AutoTinker sandbox"


class InvalidOutputError(Exception):
    pass


def _no_network(*_args: Any, **_kwargs: Any) -> NoReturn:
    raise RuntimeError(NETWORK_BLOCKED_MSG)


def block_network() -> None:
    """Make every outbound connection / DNS lookup raise. Keeps socket.socket itself (socketpair etc.)."""
    socket.socket.connect = _no_network  # type: ignore[method-assign]
    socket.socket.connect_ex = _no_network  # type: ignore[method-assign]
    socket.socket.sendto = _no_network  # type: ignore[method-assign]
    socket.create_connection = _no_network
    socket.getaddrinfo = _no_network
    socket.gethostbyname = _no_network
    socket.gethostbyname_ex = _no_network
    socket.gethostbyaddr = _no_network


def apply_memory_limit(memory_mb: int) -> bool:
    """Best-effort kernel memory limit (works on Linux; macOS refuses, the parent RSS watchdog covers it)."""
    try:
        import resource
    except ImportError:  # pragma: no cover - non-Unix
        return False
    # Backstop only (the parent's RSS watchdog enforces the real budget); floor it so that importing
    # numpy/pandas/sklearn with their thread arenas never trips it.
    limit = max(int(memory_mb * 1.5), 1024) * 1024 * 1024
    for name in ("RLIMIT_DATA", "RLIMIT_AS"):
        res = getattr(resource, name, None)
        if res is None:
            continue
        try:
            resource.setrlimit(res, (limit, limit))
            return True
        except (ValueError, OSError):
            continue
    return False


def _predict(est: Any, X: Any, need_proba: bool, n_classes: int) -> np.ndarray[Any, Any]:
    n = len(X)
    if need_proba:
        if not hasattr(est, "predict_proba"):
            raise InvalidOutputError("the metric needs predict_proba, but the estimator does not provide it")
        p = np.asarray(est.predict_proba(X), dtype=float)
        if p.ndim != 2 or p.shape[0] != n:
            raise InvalidOutputError(f"predict_proba returned shape {p.shape}, expected ({n}, n_classes)")
        classes = getattr(est, "classes_", None)
        if classes is None:
            if p.shape[1] != n_classes:
                raise InvalidOutputError(f"predict_proba has {p.shape[1]} columns, expected {n_classes}")
            return p
        classes = np.asarray(classes)
        if len(classes) != p.shape[1]:
            raise InvalidOutputError("predict_proba columns do not match estimator.classes_")
        full = np.zeros((n, n_classes), dtype=float)
        for j, c in enumerate(classes):
            ci = int(c)
            if ci != c or not 0 <= ci < n_classes:
                raise InvalidOutputError(
                    f"estimator.classes_ contains {c!r}; expected integers 0..{n_classes - 1}"
                )
            full[:, ci] = p[:, j]
        return full
    pred = np.asarray(est.predict(X))
    if pred.ndim == 2 and pred.shape[1] == 1:
        pred = pred.ravel()
    if pred.shape != (n,):
        raise InvalidOutputError(f"predict returned shape {pred.shape}, expected ({n},)")
    try:
        out = pred.astype(float)
    except (TypeError, ValueError) as e:
        raise InvalidOutputError(f"predict returned non-numeric values ({pred.dtype})") from e
    return out


def _check_finite(arr: np.ndarray[Any, Any], what: str) -> None:
    if not np.all(np.isfinite(arr)):
        raise InvalidOutputError(f"{what} contain NaN or inf")


def _load_solution(path: str) -> Any:
    spec = importlib.util.spec_from_file_location("solution", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load solution.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    build = getattr(module, "build_pipeline", None)
    if not callable(build):
        raise RuntimeError("solution.py does not define a callable build_pipeline(profile)")
    return build


def _fresh(build: Any, profile: dict[str, Any]) -> Any:
    est = build(json.loads(json.dumps(profile)))  # a fresh copy each time, so mutations do not carry over
    if est is None or not hasattr(est, "fit"):
        raise InvalidOutputError(f"build_pipeline returned {type(est).__name__}, not an estimator with .fit")
    return est


def run(job: dict[str, Any]) -> dict[str, Any]:
    mode = job["mode"]
    need_proba = bool(job["need_proba"])
    n_classes = int(job["n_classes"])
    profile = job["profile"]
    with open(job["data_path"], "rb") as f:
        data = pickle.load(f)
    build = _load_solution(job["solution_path"])
    arrays: dict[str, np.ndarray[Any, Any]] = {}
    fit_times: list[float] = []

    def fit_predict(X_fit: Any, y_fit: Any, X_pred: Any, key: str) -> None:
        est = _fresh(build, profile)
        t0 = time.perf_counter()
        est.fit(X_fit, y_fit)
        fit_times.append(time.perf_counter() - t0)
        pred = _predict(est, X_pred, need_proba, n_classes)
        _check_finite(pred, f"predictions ({key})")
        arrays[key] = pred

    if mode == "cv":
        X, y = data["X_dev"], data["y_dev"]
        for i, (tr, va) in enumerate(data["folds"]):
            fit_predict(X.iloc[tr], y[tr], X.iloc[va], f"fold_{i}")
        cv_fit_times = list(fit_times)
        fit_predict(X, y, data["X_select"], "select")
        fit_time = float(np.mean(cv_fit_times))
    elif mode == "test":
        fit_predict(data["X_fit"], data["y_fit"], data["X_test"], "test")
        fit_time = fit_times[0]
    elif mode == "tune":
        return _tune(job, data, build, profile, need_proba, n_classes)
    else:
        raise ValueError(f"unknown mode {mode!r}")

    np.savez(job["preds_path"], **arrays)  # type: ignore[arg-type]
    return {"ok": True, "fit_time_s": fit_time, "n_arrays": len(arrays)}


def _suggest(trial: Any, name: str, sp: dict[str, Any]) -> Any:
    kind = sp.get("type")
    if kind == "categorical":
        return trial.suggest_categorical(name, list(sp["choices"]))
    if kind == "int":
        return trial.suggest_int(name, int(sp["low"]), int(sp["high"]), log=bool(sp.get("log")))
    return trial.suggest_float(name, float(sp["low"]), float(sp["high"]), log=bool(sp.get("log")))


def _tune(
    job: dict[str, Any],
    data: dict[str, Any],
    build: Any,
    profile: dict[str, Any],
    need_proba: bool,
    n_classes: int,
) -> dict[str, Any]:
    import optuna

    from autotinker.contracts import Metric, ProblemType
    from autotinker.harness import scorer

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    metric, ptype = Metric(job["metric"]), ProblemType(job["problem_type"])
    space: dict[str, dict[str, Any]] = job["space"]
    X, y = data["X_dev"], data["y_dev"]
    folds = list(data["folds"])[: max(int(job.get("tune_folds", 3)), 2)]
    errors: list[str] = []

    def objective(trial: Any) -> float:
        params = {name: _suggest(trial, name, sp) for name, sp in space.items()}
        scores = []
        for tr, va in folds:
            est = _fresh(build, profile)
            est.set_params(**params)
            est.fit(X.iloc[tr], y[tr])
            pred = _predict(est, X.iloc[va], need_proba, n_classes)
            _check_finite(pred, "predictions")
            scores.append(scorer.score(metric, ptype, y[va], pred, n_classes))
        value = float(np.mean(scores))
        print(json.dumps({"trial": trial.number, "value": value, "params": params}, default=str), flush=True)
        return value

    def on_fail(study: Any, frozen: Any) -> None:
        if frozen.state == optuna.trial.TrialState.FAIL:
            msg = str(frozen.user_attrs.get("error") or frozen.system_attrs.get("fail_reason") or "failed")
            errors.append(msg[-500:])

    def guarded(trial: Any) -> float:
        try:
            return objective(trial)
        except Exception as e:  # noqa: BLE001 - a bad parameter combination fails the trial, not the study
            trial.set_user_attr("error", f"{type(e).__name__}: {e}")
            print(f"trial {trial.number} failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            raise

    study = optuna.create_study(
        direction="maximize", sampler=optuna.samplers.TPESampler(seed=int(job.get("seed", 0)))
    )
    t0 = time.perf_counter()
    study.optimize(
        guarded,
        n_trials=int(job["n_trials"]),
        timeout=float(job["time_budget_s"]),
        catch=(Exception,),
        callbacks=[on_fail],
    )
    trials: list[dict[str, Any]] = []
    best: dict[str, Any] | None = None
    for t in study.trials:
        start, end = t.datetime_start, t.datetime_complete
        dur = (end - start).total_seconds() if start is not None and end is not None else 0.0
        val = float(t.value) if t.value is not None and np.isfinite(t.value) else None
        state = {"COMPLETE": "complete", "PRUNED": "pruned"}.get(t.state.name, "fail")
        row = {"number": t.number, "params": t.params, "value": val, "state": state, "duration_s": dur}
        trials.append(row)
        if state == "complete" and val is not None and (best is None or val > float(best["value"])):
            best = row
    if best is None:
        raise InvalidOutputError("no tuning trial succeeded; first error: " + (errors[0] if errors else "?"))
    np.savez(job["preds_path"], tune=np.zeros(1))
    return {
        "ok": True,
        "fit_time_s": (time.perf_counter() - t0) / max(len(trials), 1),
        "trials": trials,
        "best_params": best["params"],
        "best_value": best["value"],
    }


def _write_result(path: str, payload: dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, default=str)
    os.replace(tmp, path)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m autotinker.harness.worker <job.json>", file=sys.stderr)
        return 2
    with open(argv[1]) as f:
        job = json.load(f)
    result_path = job["result_path"]
    job["rlimit_applied"] = apply_memory_limit(int(job["memory_mb"]))
    block_network()
    random.seed(int(job.get("seed", 0)))
    np.random.seed(int(job.get("seed", 0)) % (2**32))
    try:
        payload = run(job)
    except MemoryError:
        traceback.print_exc()
        payload = {
            "ok": False,
            "error_kind": "memory",
            "error": "MemoryError: the solution ran out of memory",
        }
    except InvalidOutputError as e:
        traceback.print_exc()
        payload = {"ok": False, "error_kind": "invalid_output", "error": str(e)}
    except BaseException as e:  # noqa: BLE001 - any failure of the solution is a runtime error
        traceback.print_exc()
        payload = {"ok": False, "error_kind": "runtime", "error": f"{type(e).__name__}: {e}"}
    with contextlib.suppress(Exception):
        sys.stdout.flush()
        sys.stderr.flush()
    _write_result(result_path, payload)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
