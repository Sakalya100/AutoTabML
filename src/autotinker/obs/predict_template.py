"""Make predictions with the AutoTinker model in this folder.

Shipped as `predict.py` next to `model.joblib`, `model_card.json`, `pipeline.py` and `requirements.txt`.
It needs nothing from AutoTinker, only the packages in requirements.txt (install those exact versions: a
joblib model loads reliably only with the scikit-learn it was saved with).

Command line:

    pip install -r requirements.txt
    python predict.py new_rows.csv -o predictions.csv

From Python (run from this folder, or put it on sys.path):

    from predict import load, predict
    model = load()                      # this folder; or load("path/to/folder")
    out = predict(model, df)            # a DataFrame: `prediction` (+ `proba_<class>` for classifiers)

Input files: .csv / .tsv / .txt (comma, semicolon, tab or pipe delimited; decimal commas like 7,4 are
understood) or .parquet. The format comes from `--delimiter/--encoding/--decimal`, else model_card.json's
`csv_format` (the training file's, used when the new file fits it), else it is detected; encodings tried:
utf-8, utf-8-sig, cp1252.

What the model expects is in model_card.json: the feature columns (name, dtype, required) and an example row.
Missing required columns are an error; extra columns (the target, say) are ignored; columns are reordered and
values coerced to the training dtypes, the way the training data was read.

model.joblib holds a `LabelDecodingModel`: a thin wrapper around the fitted scikit-learn estimator whose
`predict` returns the original class names (the estimator itself was trained on labels encoded 0..k-1, where
label i is `classes_[i]`) and whose `predict_proba` columns follow `classes_`. The raw estimator is
`model.model`. Unpickling the wrapper needs this file importable as `predict` (and, when the solution defines
its own classes, `pipeline.py` importable as `pipeline`), which `load()` arranges.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
MODEL_FILE = "model.joblib"
CARD_FILE = "model_card.json"
# The strings AutoTinker read as "missing" when it loaded the training data.
NA_VALUES = ["", "NA", "N/A", "n/a", "NaN", "nan", "NULL", "null", "None", "#N/A", "?"]
DELIMITERS = (",", "\t", ";", "|")
ENCODINGS = ("utf-8", "utf-8-sig", "cp1252")
_SNIFF_BYTES = 64 * 1024
_DECIMAL_COMMA = re.compile(r"^[+-]?\d+,\d+$")
_DECIMAL_POINT = re.compile(r"^[+-]?\d+\.\d+$")
_TRUE = {"true", "t", "yes", "y", "1", "1.0"}
_FALSE = {"false", "f", "no", "n", "0", "0.0"}


class MissingColumnsError(ValueError):
    """The input table lacks columns the model needs."""


def _text(v: Any) -> Any:
    """A value as the text it would have been in the training CSV (2.0 -> "2")."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _coerce(s: pd.Series, dtype: str) -> pd.Series:
    """Coerce one column to its training dtype; unparseable values become missing."""
    d = dtype.lower()
    if d.startswith(("int", "uint", "float")):
        if s.dtype == object or str(s.dtype).startswith("str"):
            s = s.map(
                lambda v: (
                    v.strip().replace(",", ".")
                    if isinstance(v, str) and _DECIMAL_COMMA.match(v.strip())
                    else v
                )
            )
        out = pd.to_numeric(s, errors="coerce")
        if (
            d.startswith(("int", "uint"))
            and not out.isna().any()
            and np.all(np.mod(out.to_numpy(float), 1) == 0)
        ):
            return out.astype("int64")
        return out.astype("float64")
    if d.startswith("bool"):
        if s.dtype == bool:
            return s
        low = s.map(lambda v: v if pd.isna(v) else str(v).strip().lower())
        mapped = low.map(lambda v: True if v in _TRUE else False if v in _FALSE else None)
        return mapped.astype(bool) if not mapped.isna().any() else mapped.astype(object)
    if d.startswith("datetime"):
        return pd.to_datetime(s, errors="coerce")
    if d == "category":
        return s.map(lambda v: v if pd.isna(v) else _text(v)).astype("category")
    # text columns (object / str / string): compare as the strings the training data held
    out = s.map(lambda v: v if pd.isna(v) else _text(v)).astype(object)
    if d != "object":
        try:
            converted: pd.Series = out.astype(pd.api.types.pandas_dtype(dtype))
            return converted
        except (TypeError, ValueError):
            return out
    return out


def prepare(df: pd.DataFrame, features: Sequence[dict[str, Any]]) -> pd.DataFrame:
    """The model's input columns, in training order and dtypes. Raises MissingColumnsError."""
    df = df.rename(columns=lambda c: str(c).strip())
    names = [str(f["name"]) for f in features]
    missing = [f["name"] for f in features if f.get("required", True) and f["name"] not in df.columns]
    if missing:
        raise MissingColumnsError(
            f"missing column(s): {', '.join(map(str, missing))}. "
            f"The model expects: {', '.join(names)} (see {CARD_FILE})."
        )
    out = pd.DataFrame(index=df.index)
    for f in features:
        name = str(f["name"])
        col = df[name] if name in df.columns else pd.Series(np.nan, index=df.index, dtype=object)
        out[name] = _coerce(col, str(f.get("dtype", "object")))
    return out


class LabelDecodingModel:
    """A fitted estimator that takes raw input rows and answers in the original labels.

    `model` is the raw fitted estimator (predicts encoded labels 0..k-1 for classification); `classes_[i]`
    is the original name of encoded label i. Inputs go through `prepare` (column check, reorder, dtype
    coercion) first.
    """

    def __init__(
        self, model: Any, classes: Sequence[Any] | None, features: Sequence[dict[str, Any]], problem_type: str
    ) -> None:
        self.model = model
        self.classes_ = np.asarray(list(classes), dtype=object) if classes is not None else None
        self.features = [dict(f) for f in features]
        self.problem_type = problem_type

    @property
    def feature_names_in_(self) -> np.ndarray[Any, Any]:
        return np.asarray([f["name"] for f in self.features], dtype=object)

    def prepare(self, X: pd.DataFrame) -> pd.DataFrame:
        if not isinstance(X, pd.DataFrame):
            X = pd.DataFrame(X, columns=self.feature_names_in_)
        return prepare(X, self.features)

    def decode(self, encoded: Any) -> np.ndarray[Any, Any]:
        """Encoded labels 0..k-1 -> original class names."""
        arr = np.asarray(encoded)
        if self.classes_ is None:
            return arr
        if arr.ndim == 2:
            arr = arr.argmax(axis=1) if arr.shape[1] > 1 else arr.ravel()
        k = len(self.classes_)
        idx = np.asarray(arr, dtype=float).round().astype(int)
        if np.any((idx < 0) | (idx >= k)):
            raise ValueError(f"the model predicted labels outside 0..{k - 1}")
        decoded: np.ndarray[Any, Any] = self.classes_[idx]
        return decoded

    def predict(self, X: pd.DataFrame) -> np.ndarray[Any, Any]:
        raw = np.asarray(self.model.predict(self.prepare(X)))
        if self.classes_ is None:
            return raw.reshape(len(raw), -1)[:, 0] if raw.ndim == 2 else raw
        return self.decode(raw)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray[Any, Any]:
        """Class probabilities, one column per `classes_` entry (in that order)."""
        if self.classes_ is None or not hasattr(self.model, "predict_proba"):
            raise AttributeError("this model does not provide class probabilities")
        p = np.asarray(self.model.predict_proba(self.prepare(X)), dtype=float)
        k = len(self.classes_)
        cols = getattr(self.model, "classes_", None)
        if cols is None or (p.shape[1] == k and list(np.asarray(cols).tolist()) == list(range(k))):
            return p
        full = np.zeros((p.shape[0], k), dtype=float)
        for j, c in enumerate(np.asarray(cols).tolist()):
            full[:, int(c)] = p[:, j]
        return full


def read_card(folder: str | Path | None = None) -> dict[str, Any]:
    path = Path(folder) if folder is not None else HERE
    path = path / CARD_FILE if path.is_dir() else path
    with open(path, encoding="utf-8") as f:
        card: dict[str, Any] = json.load(f)
    return card


def load(folder: str | Path | None = None) -> LabelDecodingModel:
    """Load model.joblib from `folder` (default: the folder this file is in)."""
    import joblib

    d = Path(folder) if folder is not None else HERE
    model_path = d if d.is_file() else d / MODEL_FILE
    d = model_path.parent.resolve()
    if str(d) not in sys.path:
        sys.path.insert(
            0, str(d)
        )  # `pipeline` (the solution's own classes, if any) and `predict` resolve here
    sys.modules.setdefault("predict", sys.modules[__name__])  # run as a script: the pickle names `predict.*`
    obj = joblib.load(model_path)
    if isinstance(obj, LabelDecodingModel) or type(obj).__name__ == "LabelDecodingModel":
        return obj  # type: ignore[no-any-return]
    card = read_card(d)  # an unwrapped estimator: wrap it with what the card says
    return LabelDecodingModel(obj, card.get("classes"), card["features"], str(card["problem_type"]))


def predict(model: LabelDecodingModel | str | Path | None, df: pd.DataFrame) -> pd.DataFrame:
    """Predictions for the rows of `df`: a `prediction` column (original labels for classifiers) and, for
    classifiers that provide them, one `proba_<class>` column per class. Same row order and index as `df`."""
    m = model if isinstance(model, LabelDecodingModel) else load(model)
    X = m.prepare(df)
    out = pd.DataFrame(index=df.index)
    out["prediction"] = m.predict(X)
    if m.classes_ is not None and hasattr(m.model, "predict_proba"):
        try:
            p = m.predict_proba(X)
        except Exception as e:  # noqa: BLE001 - labels are still useful without probabilities
            print(f"note: no class probabilities ({type(e).__name__}: {e})", file=sys.stderr)
        else:
            for j, c in enumerate(m.classes_.tolist()):
                out[f"proba_{c}"] = p[:, j]
    return out


def _decode(data: bytes, encoding: str | None) -> tuple[str, str]:
    """(text, encoding): the given encoding, else the first of utf-8 / utf-8-sig / cp1252 that decodes."""
    if encoding:
        return data.decode(encoding), encoding
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig"), "utf-8-sig"
    for enc in ENCODINGS:
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1"), "latin-1"  # decodes any bytes


def sniff_delimiter(text: str) -> str:
    """csv.Sniffer restricted to , TAB ; |; when it can't decide, the candidate that splits the first lines
    into the same non-zero number of fields most often."""
    sample = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(sample, delimiters="".join(DELIMITERS)).delimiter
    except csv.Error:
        pass
    lines = [ln for ln in sample.splitlines() if ln.strip()][:12]
    best, best_score = ",", (0, 0)
    for d in DELIMITERS:
        counts = [ln.count(d) for ln in lines]
        if not counts or counts[0] == 0:
            continue
        score = (sum(c == counts[0] for c in counts), counts[0])
        if score > best_score:
            best, best_score = d, score
    return best


def sniff_decimal(text: str, delimiter: str) -> str:
    """ "," when the delimiter isn't a comma and numbers look like 7,4 (and none like 7.4); else "."."""
    if delimiter == ",":
        return "."
    comma = point = 0
    for row in csv.reader(io.StringIO("\n".join(text.splitlines()[:200])), delimiter=delimiter):
        for field in row:
            f = field.strip()
            comma += bool(_DECIMAL_COMMA.match(f))
            point += bool(_DECIMAL_POINT.match(f))
    return "," if comma and not point else "."


def card_csv_format(folder: str | Path | None = None) -> dict[str, str | None]:
    """model_card.json's `csv_format` (the training file's format), or all-None when absent."""
    try:
        fmt = read_card(folder).get("csv_format")
    except (OSError, ValueError):
        fmt = None
    fmt = fmt if isinstance(fmt, dict) else {}
    return {k: fmt.get(k) or None for k in ("delimiter", "encoding", "decimal")}


def read_table(
    path: str | Path,
    csv_format: dict[str, str | None] | None = None,
    hint: dict[str, str | None] | None = None,
) -> pd.DataFrame:
    """Read rows to predict. `csv_format` ({delimiter, encoding, decimal}) is used as given; `hint` (the
    training file's format from the card) is used where the file fits it; anything left open is detected."""
    p = Path(path)
    if p.suffix.lower() in (".parquet", ".pq"):
        return pd.read_parquet(p)
    fmt = {k: v for k, v in (csv_format or {}).items() if v}
    hint = {k: v for k, v in (hint or {}).items() if v}
    data = p.read_bytes()
    try:
        text, _enc = _decode(data, fmt.get("encoding") or hint.get("encoding"))
    except (UnicodeDecodeError, LookupError):
        if fmt.get("encoding"):
            raise
        text, _enc = _decode(data, None)
    head = text[:_SNIFF_BYTES]
    first = next((ln for ln in head.splitlines() if ln.strip()), "")
    delimiter = fmt.get("delimiter")
    hinted = hint.get("delimiter")
    if not delimiter and hinted and hinted in first:
        delimiter = hinted
        fmt.setdefault("decimal", hint.get("decimal") or "")
    if not delimiter:
        delimiter = "\t" if p.suffix.lower() == ".tsv" and "\t" in first else sniff_delimiter(head)
    decimal = fmt.get("decimal") or sniff_decimal(head, delimiter)
    return pd.read_csv(
        io.StringIO(text),
        sep=delimiter,
        decimal=decimal,
        na_values=NA_VALUES,
        keep_default_na=True,
        skipinitialspace=delimiter != "\t",
    )


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Predict with the AutoTinker model in this folder.")
    ap.add_argument("input", help="rows to predict: .csv, .tsv or .parquet, with the training columns")
    ap.add_argument("-o", "--output", help="where to write the predictions (.csv); default: print them")
    ap.add_argument("--model", default=None, help="folder holding model.joblib (default: next to this file)")
    ap.add_argument("--keep-input", action="store_true", help="put the input columns before the predictions")
    ap.add_argument("--delimiter", help="field separator, e.g. ';' or 'tab' (default: detected)")
    ap.add_argument("--encoding", help="text encoding, e.g. utf-8 or cp1252 (default: detected)")
    ap.add_argument("--decimal", choices=[".", ","], help="decimal mark (default: detected)")
    args = ap.parse_args(argv)
    given = {"delimiter": args.delimiter, "encoding": args.encoding, "decimal": args.decimal}
    if given["delimiter"] in ("tab", "\\t"):
        given["delimiter"] = "\t"
    try:
        df = read_table(args.input, given, hint=card_csv_format(args.model))
        model = load(args.model)
        out = predict(model, df)
    except MissingColumnsError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if args.keep_input:
        out = pd.concat([df, out], axis=1)
    if args.output:
        out.to_csv(args.output, index=False)
        print(f"wrote {len(out)} predictions to {args.output}", file=sys.stderr)
    else:
        out.to_csv(sys.stdout, index=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
