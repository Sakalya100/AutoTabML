# Releasing `autotinker` to PyPI

The engine package (`src/autotinker`) is published to PyPI by [`.github/workflows/release.yml`](../.github/workflows/release.yml) whenever a GitHub release is **published**. The workflow uses [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/): GitHub proves its identity to PyPI over OIDC, so there is no API token to create, store or leak.

The workflow runs three jobs:
1. **test**: ruff, ruff format, mypy and pytest (same as CI).
2. **build**: checks that the release tag equals the `version` in `pyproject.toml` (tag `v0.1.0` ↔ version `0.1.0`), runs `uv build` and `twine check --strict`, installs the wheel into a fresh venv and runs `autotinker --help`.
3. **publish**: uploads `dist/` to PyPI from the `pypi` environment.

Only the engine is published. The sdist and wheel contain `src/autotinker` plus `pyproject.toml`, `README.md` and `LICENSE`; `backend/`, `web/`, `tests/`, `benchmarks/`, `docs/` and `schema/` are left out.

## One-time setup (owner)

1. **Make the repository public** (or accept that the PyPI page's Source / Issues / Roadmap links will 404 for everyone else). The README is the PyPI long description, and its links point at `github.com/Sakalya100/AutoTinker/blob/main/...`, so the release should be cut from `main` after `v2` is merged.
2. **Create the GitHub environment.** Repo → Settings → Environments → New environment → name it exactly `pypi`. Optional but recommended: add yourself as a required reviewer, so every publish waits for a click.
3. **Add a pending publisher on PyPI** (the project doesn't exist on PyPI yet; `https://pypi.org/pypi/autotinker/json` returned 404 on 2026-10-09, so the name is free). Log in to pypi.org → your account → Publishing → "Add a new pending publisher" → GitHub, and fill in exactly:

   | field | value |
   |---|---|
   | PyPI Project Name | `autotinker` |
   | Owner | `Sakalya100` |
   | Repository name | `AutoTinker` |
   | Workflow name | `release.yml` |
   | Environment name | `pypi` |

   The first successful publish turns the pending publisher into a normal one and creates the project under your account.

Optional dry run: add the same pending publisher on [test.pypi.org](https://test.pypi.org) and temporarily set `repository-url: https://test.pypi.org/legacy/` on the publish step.

## Every release

1. Set the version in **both** `pyproject.toml` and `src/autotinker/__init__.py` (a test fails if they differ), then run `uv lock` so `uv.lock` matches.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](../CHANGELOG.md) under a new `## [X.Y.Z] - YYYY-MM-DD` heading. For 0.1.0 the entry is already written; set its date to the actual release day.
3. Check locally:
   ```bash
   uv run pytest -q && uv run ruff check src tests benchmarks && uv run ruff format --check src tests && uv run mypy
   rm -rf dist && uv build && uvx twine check --strict dist/*
   ```
4. Commit, merge to `main`, then tag and push:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
5. GitHub → Releases → "Draft a new release" → choose tag `v0.1.0` → paste the changelog entry → **Publish release**. This starts the workflow; approve the `pypi` environment if you added a reviewer.
6. Verify from a clean environment:
   ```bash
   uv venv /tmp/at-pypi && uv pip install -p /tmp/at-pypi autotinker==0.1.0
   /tmp/at-pypi/bin/autotinker --help
   ```
7. Bump to the next dev version (e.g. `0.1.1.dev0`) in both files and add an empty `Unreleased` section.

A PyPI version can't be re-uploaded, even after deleting it. If a release is broken, fix it and publish the next patch version.

## After the first release

The hosted runner (`backend/autotinker_api/runners/sandbox.py`) installs the engine from git (`DEFAULT_PACKAGE = "autotinker @ git+https://github.com/Sakalya100/AutoTinker@v2"`). Once 0.1.0 is on PyPI you can pin the sandbox to the release with the `AUTOTINKER_SANDBOX_PACKAGE` env var (e.g. `autotinker==0.1.0`) instead of tracking the `v2` branch (`pypi.org` and `files.pythonhosted.org` are already in its install hosts). That is a backend change, not part of the release itself.
