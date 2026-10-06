from __future__ import annotations

import ast

import pytest

from autotabml.agent.context import KeptSolution, ProposalContext
from autotabml.agent.heuristic import HeuristicProposer, default_spec, parse_spec, render
from autotabml.contracts import IdeaCategory, ProblemType
from tests.conftest import make_profile

try:
    from autotabml.harness.static_check import static_check
except ImportError:  # harness not built yet
    static_check = None  # type: ignore[assignment]


def _check(code: str) -> None:
    ast.parse(code)
    assert "def build_pipeline(profile)" in code
    assert ".fit(" not in code
    if static_check is not None:
        errors, _ = static_check(code)
        assert not errors, errors


@pytest.mark.parametrize("problem", [ProblemType.multiclass, ProblemType.binary, ProblemType.regression])
def test_heuristic_walk_produces_valid_code(problem: ProblemType) -> None:
    prof = make_profile(problem)
    hp = HeuristicProposer(seed=3)
    draft = hp.draft(ProposalContext(profile=prof))
    _check(draft.code)
    best = draft.code
    kept = [KeptSolution("e000", best, 0.5)]
    seen_radical = seen_ens = False
    titles = set()
    for i in range(1, 40):
        p = hp.propose_and_implement(
            ProposalContext(
                profile=prof,
                best_code=best,
                kept=kept,
                exp_index=i,
                since_last_keep=i % 6,
                best_exp_id=kept[0].exp_id,
            )
        )
        _check(p.code)
        assert p.usages == []
        assert parse_spec(p.code) is not None
        titles.add(p.idea.title)
        seen_radical |= p.idea.radical
        seen_ens |= p.idea.category == IdeaCategory.ensembling
        if p.idea.category in (IdeaCategory.model_family, IdeaCategory.ensembling):
            assert p.idea.radical
        if i in (5, 11):
            best = p.code
            kept.insert(0, KeptSolution(f"e{i:03d}", p.code, 0.6 + i / 100))
    assert seen_radical and seen_ens
    assert len(titles) > 20  # deduplicated ideas, not the same one repeated


def test_heuristic_is_deterministic() -> None:
    prof = make_profile()

    def walk(seed: int) -> list[str]:
        hp = HeuristicProposer(seed=seed)
        return [
            hp.propose_and_implement(ProposalContext(profile=prof, exp_index=i)).idea.title
            for i in range(1, 8)
        ]

    assert walk(1) == walk(1)
    assert walk(1) != walk(2)


def test_escalates_to_radical_after_patience() -> None:
    def n_radical(since: int) -> int:
        prof = make_profile()
        return sum(  # fresh proposer each time so the radical pool is never exhausted
            HeuristicProposer(seed=0, patience=3)
            .propose_and_implement(ProposalContext(profile=prof, exp_index=i, since_last_keep=since))
            .idea.radical
            for i in range(1, 21)
        )

    assert n_radical(3) >= 8 > n_radical(0)


def test_starter_code_without_spec_uses_default_and_repair_simplifies() -> None:
    hp = HeuristicProposer()
    p = hp.propose_and_implement(
        ProposalContext(profile=make_profile(), best_code="def build_pipeline(p): ...", exp_index=1)
    )
    _check(p.code)
    spec = {"model": "ensemble", "ens": "vote", "params": {}, "members": [default_spec(), default_spec()]}
    rep = hp.repair(ProposalContext(profile=make_profile()), render(spec, ProblemType.multiclass), "boom")
    assert parse_spec(rep.code) == default_spec() and "ensemble" in rep.note
