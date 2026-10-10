"""The PyPI README (README.pypi.md) must match README.md, with every mermaid diagram rendered to a PNG."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("readme_assets", ROOT / "tools" / "readme_assets.py")
assert spec and spec.loader
readme_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readme_assets)


def test_pypi_readme_and_diagrams_are_up_to_date() -> None:
    assert readme_assets.check() == []


def test_every_diagram_becomes_an_image_with_alt_text() -> None:
    text = (ROOT / "README.md").read_text()
    pypi = (ROOT / "README.pypi.md").read_text()
    assert len(readme_assets.blocks(text)) >= 1
    assert "```mermaid" not in pypi
    for src in readme_assets.blocks(text):
        assert readme_assets.asset_name(src) in pypi
    assert "![Diagram" not in pypi  # every diagram has real alt text
