"""Proposers turn a ProposalContext into (Idea, solution.py code).

`LLMProposer` asks an LLM for structured JSON. `HeuristicProposer` (agent/heuristic.py) runs fully offline.
"""

from __future__ import annotations

from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from autotinker.agent import prompts
from autotinker.agent.context import Proposal, ProposalContext, RepairResult
from autotinker.agent.llm import LLM, Purpose
from autotinker.contracts import Idea, IdeaCategory, LLMUsage

T = TypeVar("T", bound=BaseModel)


class Proposer(Protocol):
    label: str  # "heuristic" or "llm:<model>"

    def draft(self, ctx: ProposalContext) -> Proposal: ...

    def propose_and_implement(self, ctx: ProposalContext) -> Proposal: ...

    def repair(self, ctx: ProposalContext, code: str, error_tail: str) -> RepairResult: ...


class ProposalFailed(RuntimeError):
    def __init__(self, msg: str, usages: list[LLMUsage]):
        super().__init__(msg)
        self.usages = usages


class LLMProposer:
    """Strong model proposes; optional cheap model implements and repairs (ROADMAP §10 cost mitigation)."""

    def __init__(self, llm: LLM, cheap_llm: LLM | None = None, *, max_tokens: int = 16000) -> None:
        self.llm = llm
        self.cheap_llm = cheap_llm
        self.max_tokens = max_tokens
        self.label = f"llm:{llm.model}" + (f"+{cheap_llm.model}" if cheap_llm else "")

    def _ask(
        self, llm: LLM, system: str, messages: list[dict[str, Any]], out: type[T], purpose: Purpose
    ) -> tuple[T, list[LLMUsage]]:
        """One call, plus one retry if the reply cannot be parsed."""
        usages: list[LLMUsage] = []
        msgs = list(messages)
        last_err = ""
        max_tokens = self.max_tokens
        for attempt in range(2):
            resp = llm.complete(system, msgs, max_tokens=max_tokens, purpose=purpose)
            usages.append(resp.usage)
            if resp.stop_reason in ("max_tokens", "length"):
                last_err = "reply was truncated at max_tokens"
                max_tokens *= 2  # thinking counts toward max_tokens; give the retry room
            else:
                try:
                    return prompts.parse_structured(resp.text, out), usages
                except prompts.ParseError as exc:
                    last_err = str(exc)
            if attempt == 0:
                msgs = [
                    *msgs,
                    {"role": "assistant", "content": resp.text or "(empty)"},
                    prompts.retry_message(last_err),
                ]
        raise ProposalFailed(f"could not parse {purpose} reply after retry: {last_err}", usages)

    @staticmethod
    def _idea(o: prompts.ProposalOut | prompts.IdeaOut) -> Idea:
        cat = (
            o.category
            if o.category not in (IdeaCategory.baseline, IdeaCategory.repair)
            else IdeaCategory.model_family
        )
        return Idea(title=o.title.strip(), rationale=o.rationale.strip(), category=cat, radical=o.radical)

    def draft(self, ctx: ProposalContext) -> Proposal:
        out, usages = self._ask(
            self.llm, prompts.system_prompt(ctx), prompts.draft_messages(ctx), prompts.ProposalOut, "draft"
        )
        return Proposal(self._idea(out), out.code, usages)

    def propose_and_implement(self, ctx: ProposalContext) -> Proposal:
        system = prompts.system_prompt(ctx)
        if self.cheap_llm is None:
            out, usages = self._ask(
                self.llm, system, prompts.propose_messages(ctx), prompts.ProposalOut, "propose"
            )
            return Proposal(self._idea(out), out.code, usages)
        idea_out, u1 = self._ask(
            self.llm, system, prompts.idea_only_messages(ctx), prompts.IdeaOut, "propose"
        )
        code_out, u2 = self._ask(
            self.cheap_llm,
            system,
            prompts.implement_messages(ctx, idea_out.title, idea_out.rationale),
            prompts.CodeOut,
            "implement",
        )
        return Proposal(self._idea(idea_out), code_out.code, u1 + u2)

    def repair(self, ctx: ProposalContext, code: str, error_tail: str) -> RepairResult:
        llm = self.cheap_llm or self.llm
        out, usages = self._ask(
            llm,
            prompts.system_prompt(ctx),
            prompts.repair_messages(ctx, code, error_tail),
            prompts.CodeOut,
            "repair",
        )
        return RepairResult(out.code, usages, out.notes)


def make_proposer(spec: str, *, cheap: str | None = None, seed: int = 0) -> Proposer:
    """ "heuristic" -> offline HeuristicProposer; anything else -> LLMProposer(make_llm(spec))."""
    if spec == "heuristic":
        from autotinker.agent.heuristic import HeuristicProposer

        return HeuristicProposer(seed=seed)
    from autotinker.agent.llm import make_llm

    return LLMProposer(make_llm(spec), make_llm(cheap) if cheap else None)
