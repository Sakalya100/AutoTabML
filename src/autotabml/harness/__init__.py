"""The harness: fixed splits, sandboxed execution and scoring. Read-only to the agent."""

from autotabml.harness.contract import CONTRACT_DOC, STARTER_SOLUTION, contract_doc
from autotabml.harness.core import Harness
from autotabml.harness.static_check import allowed_imports, static_check

__all__ = ["CONTRACT_DOC", "STARTER_SOLUTION", "Harness", "allowed_imports", "contract_doc", "static_check"]
