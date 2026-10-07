from __future__ import annotations

import pytest

from autotinker.harness import STARTER_SOLUTION, allowed_imports, static_check

OK_HEAD = "from sklearn.linear_model import LogisticRegression\n"


def _errors(code: str) -> list[str]:
    return static_check(code)[0]


def test_starter_passes() -> None:
    errors, warnings = static_check(STARTER_SOLUTION)
    assert errors == [] and warnings == []


@pytest.mark.parametrize(
    ("code", "needle"),
    [
        ("import os\ndef build_pipeline(profile):\n    return None\n", "'os' is forbidden"),
        ("from subprocess import run\ndef build_pipeline(p):\n    return None\n", "forbidden"),
        ("import requests\ndef build_pipeline(p):\n    return None\n", "forbidden"),
        ("import json\ndef build_pipeline(p):\n    return None\n", "not allowed"),
        ("def build_pipeline(p):\n    open('x')\n", "'open' is forbidden"),
        ("def build_pipeline(p):\n    return eval('1')\n", "'eval' is forbidden"),
        ("def build_pipeline(p):\n    exec('x=1')\n", "'exec' is forbidden"),
        ("def build_pipeline(p):\n    __import__('os')\n", "forbidden"),
        ("def build_pipeline(p):\n    return ().__class__.__bases__\n", "dunder"),
        ("def build_pipeline(p):\n    return getattr(p, '__class__')\n", "dunder"),
        ("def build_pipeline(p):\n    return getattr(p, '__cl' + 'ass__')\n", "literal attribute name"),
        ("def build_pipeline(p):\n    g = getattr\n    return g(p, 'x')\n", "called directly"),
        (
            "import functools\ndef build_pipeline(p):\n"
            "    return functools.reduce(getattr, ['__class__'], p)\n",
            "called directly",
        ),
        ("import pandas as pd\ndef build_pipeline(p):\n    pd.read_csv('train.csv')\n", "read_csv"),
        ("import numpy as np\ndef build_pipeline(p):\n    np.load('x.npy')\n", "load"),
        (
            "from sklearn.datasets import load_iris\ndef build_pipeline(p):\n    return None\n",
            "sklearn.datasets",
        ),
        (
            OK_HEAD
            + "def build_pipeline(p):\n    m = LogisticRegression()\n    m.fit([[0]], [0])\n    return m\n",
            ".fit(...)",
        ),
        (
            OK_HEAD + "def helper():\n    return LogisticRegression().fit_transform([[0]])\n"
            "def build_pipeline(p):\n    return helper()\n",
            ".fit_transform(...)",
        ),
        (
            OK_HEAD + "m = LogisticRegression().fit([[0]], [0])\ndef build_pipeline(p):\n    return m\n",
            "module level",
        ),
        ("from sklearn.linear_model import LogisticRegression\n", "build_pipeline"),
        ("def build_pipeline():\n    return None\n", "positional argument"),
        ("def build_pipeline(p)\n    return None\n", "syntax error"),
        ("from . import x\ndef build_pipeline(p):\n    return None\n", "relative"),
    ],
)
def test_rejections(code: str, needle: str) -> None:
    errors = _errors(code)
    assert errors, code
    assert any(needle in e for e in errors), errors


def test_fit_allowed_inside_custom_estimator_methods() -> None:
    code = (
        "import numpy as np\n"
        "from sklearn.base import BaseEstimator, TransformerMixin\n"
        "from sklearn.preprocessing import StandardScaler\n"
        "class Scaled(BaseEstimator, TransformerMixin):\n"
        "    def __init__(self):\n"
        "        super().__init__()\n"
        "    def fit(self, X, y=None):\n"
        "        self.cols_ = list(X.columns) if hasattr(X, 'columns') else None\n"
        "        self.s_ = StandardScaler().fit(X)\n"
        "        return self\n"
        "    def transform(self, X):\n"
        "        return self.s_.transform(X)\n"
        "def build_pipeline(profile):\n"
        "    return Scaled()\n"
    )
    assert _errors(code) == []


def test_warnings_and_allowlist() -> None:
    code = "def engineer_features(df):\n    return df\ndef build_pipeline(p):\n    return None\n"
    errors, warnings = static_check(code)
    assert errors == [] and any("engineer_features" in w for w in warnings)
    allowed = allowed_imports()
    assert {"sklearn", "numpy", "pandas", "scipy"} <= allowed
    assert "os" not in allowed
