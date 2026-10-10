"""Keep the PyPI README in step with README.md.

GitHub renders ```mermaid blocks; PyPI does not (it would show the diagram source as code).
So the package's long description is README.pypi.md: README.md with every mermaid block
replaced by a PNG of it, served from the repo. An `<!-- alt: ... -->` line right above a
block becomes the image's alt text. Each PNG is named after a hash of its diagram source,
so a changed diagram without a fresh render fails the check.

    python tools/readme_assets.py render   # render each diagram to docs/assets/mermaid-<hash>.png (needs npx)
    python tools/readme_assets.py pypi     # write README.pypi.md
    python tools/readme_assets.py check    # exit 1 if README.pypi.md or a diagram PNG is out of date (CI)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
PYPI_README = ROOT / "README.pypi.md"
ASSETS = ROOT / "docs" / "assets"
RAW = "https://raw.githubusercontent.com/Sakalya100/AutoTinker/main/docs/assets"
BLOCK = re.compile(r"(?:<!-- alt: (.*?) -->\n)?```mermaid\n(.*?)```\n", re.S)
HEADER = "<!-- Generated from README.md by tools/readme_assets.py; edit README.md instead. -->\n\n"


def blocks(text: str) -> list[str]:
    return [src for _alt, src in BLOCK.findall(text)]


def asset_name(source: str) -> str:
    return f"mermaid-{hashlib.sha256(source.encode()).hexdigest()[:10]}.png"


def pypi_text(text: str) -> str:
    n = 0

    def image(m: re.Match[str]) -> str:
        nonlocal n
        n += 1
        return f"![{m.group(1) or f'Diagram {n}'}]({RAW}/{asset_name(m.group(2))})\n"

    return HEADER + BLOCK.sub(image, text)


def render() -> None:
    """Render every diagram with mermaid-cli. Uses PUPPETEER_EXECUTABLE_PATH (a local Chrome) when set."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "puppeteer.json"
        exe = os.environ.get("PUPPETEER_EXECUTABLE_PATH")
        cfg.write_text(json.dumps({"args": ["--no-sandbox"], **({"executablePath": exe} if exe else {})}))
        for src in blocks(README.read_text()):
            out = ASSETS / asset_name(src)
            if out.exists():
                continue
            mmd = Path(tmp) / "d.mmd"
            mmd.write_text(src)
            cmd = ["npx", "-y", "@mermaid-js/mermaid-cli@11", "-p", str(cfg), "-i", str(mmd), "-o", str(out)]
            subprocess.run([*cmd, "-b", "white", "-w", "1000", "-s", "2"], check=True)
            print(f"rendered {out.relative_to(ROOT)}")


def check() -> list[str]:
    problems = []
    text = README.read_text()
    if not PYPI_README.exists() or PYPI_README.read_text() != pypi_text(text):
        problems.append("README.pypi.md is out of date: run `python tools/readme_assets.py pypi`")
    for src in blocks(text):
        if not (ASSETS / asset_name(src)).exists():
            name = asset_name(src)
            problems.append(f"missing diagram docs/assets/{name}: run `python tools/readme_assets.py render`")
    return problems


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "check"
    if cmd == "render":
        render()
    elif cmd == "pypi":
        PYPI_README.write_text(pypi_text(README.read_text()))
        print(f"wrote {PYPI_README.relative_to(ROOT)}")
    elif cmd == "check":
        problems = check()
        for p in problems:
            print(p, file=sys.stderr)
        return 1 if problems else 0
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
