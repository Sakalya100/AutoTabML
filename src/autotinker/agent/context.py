"""What a proposer is allowed to see. Built by the loop; never contains raw data beyond the profile."""

from __future__ import annotations

from dataclasses import dataclass, field

from autotinker.contracts import CVScore, DataProfile, Idea, LLMUsage


@dataclass(frozen=True)
class KeptSolution:
    exp_id: str
    code: str
    cv_mean: float


@dataclass
class ProposalContext:
    profile: DataProfile
    description: str = ""
    contract_doc: str = ""
    allowed_imports: frozenset[str] = frozenset()
    best_code: str = ""
    best_exp_id: str | None = None
    best_cv: CVScore | None = None
    ledger_summary: str = "(no experiments yet)"
    kept: list[KeptSolution] = field(default_factory=list)  # all kept solutions, best first
    exp_index: int = 0
    since_last_keep: int = 0  # experiments since the last keep


@dataclass
class Proposal:
    idea: Idea
    code: str
    usages: list[LLMUsage] = field(default_factory=list)


@dataclass
class RepairResult:
    code: str
    usages: list[LLMUsage] = field(default_factory=list)
    note: str = ""
