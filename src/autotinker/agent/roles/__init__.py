"""Agent roles (docs/AGENTIC_PLAN.md §2): specs, output schemas and the role runner."""

from autotinker.agent.roles.base import (
    RoleCall,
    RoleFailed,
    RoleSpec,
    StepObserver,
    parse_code_reply,
    run_role,
)
from autotinker.agent.roles.specs import ROLES, profile_text

__all__ = [
    "ROLES",
    "RoleCall",
    "RoleFailed",
    "RoleSpec",
    "StepObserver",
    "parse_code_reply",
    "profile_text",
    "run_role",
]
