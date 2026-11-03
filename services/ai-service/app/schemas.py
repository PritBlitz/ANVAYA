"""Internal API contracts and structured model-output schemas (AI_WORKFLOW §4).

Output schemas reference evidence by `evidence_id` only. Paths, line ranges and
commit SHAs are attached by the control plane from its own records, so a model
cannot invent a citation location.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

Mode = Literal["local", "cloud", "mock"]
Task = Literal[
    "repository_qa", "investigation", "planning", "migration_plan", "patch", "repair", "review", "verification_summary"
]

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
BACKSLASH = chr(92)
NUL = chr(0)


def _safe_relative_path(value: str) -> str:
    if value.startswith("/") or BACKSLASH in value or NUL in value or ".." in value.split("/"):
        raise ValueError("must be a relative path without traversal")
    return value


RelPath = Annotated[str, StringConstraints(min_length=1, max_length=500), AfterValidator(_safe_relative_path)]
EvidenceId = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Requests / responses
# ---------------------------------------------------------------------------
class EvidenceItem(Strict):
    id: EvidenceId
    path: RelPath
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    commit_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    content_hash: str = Field(max_length=100)
    language: str | None = None
    symbol: str | None = Field(default=None, max_length=300)
    content: str = Field(max_length=20000)


class Budget(Strict):
    max_input_tokens: int = Field(ge=256, le=200_000)
    max_output_tokens: int = Field(ge=64, le=32_000)
    timeout_seconds: int = Field(ge=5, le=1800)


class UntrustedInput(Strict):
    label: Annotated[str, StringConstraints(pattern=r"^[a-z_]{1,40}$")]
    content: str = Field(max_length=20000)


class GenerateRequest(Strict):
    task: Task
    mode: Mode
    provider: str | None = Field(default=None, max_length=50)
    model: str | None = Field(default=None, max_length=100)
    intent: dict[str, Any]
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=100)
    # User/issue-supplied text (task descriptions, issue bodies). Rendered as untrusted, never as instructions.
    untrusted_inputs: list[UntrustedInput] = Field(default_factory=list, max_length=5)
    context: dict[str, Any] | None = None
    budget: Budget


class Usage(BaseModel):
    input_tokens: int
    output_tokens: int
    estimated_cost_microunits: int | None = None


class GenerateResponse(BaseModel):
    task: Task
    provider: str
    model: str
    mode: Mode
    prompt_version: str
    output: dict[str, Any]
    evidence_included: list[str]
    usage: Usage
    duration_ms: int
    schema_repair_attempted: bool


class EmbedRequest(Strict):
    texts: list[Annotated[str, StringConstraints(max_length=24000)]] = Field(min_length=1, max_length=128)
    input_type: Literal["document", "query"]


class EmbedResponse(BaseModel):
    provider: str
    model: str
    model_version: str
    dimension: int
    embeddings: list[list[float]]
    usage: dict[str, int | None]
    duration_ms: int


class HealthRequest(Strict):
    mode: Mode
    provider: str | None = None


class ProviderHealth(BaseModel):
    provider: str
    mode: Mode
    available: bool
    models: list[str] = Field(default_factory=list)
    detail: str | None = None


# ---------------------------------------------------------------------------
# Structured outputs
# ---------------------------------------------------------------------------
class Citation(Strict):
    evidence_id: EvidenceId
    supports: ShortText


class QaAnswer(Strict):
    answer: LongText
    citations: list[Citation] = Field(max_length=12)
    limitations: list[ShortText] = Field(default_factory=list, max_length=8)
    insufficient_evidence: bool


class Finding(Strict):
    claim: ShortText
    evidence_ids: list[EvidenceId] = Field(max_length=8)
    kind: Literal["observed", "inferred"]


class Investigation(Strict):
    summary: LongText
    findings: list[Finding] = Field(max_length=12)
    hypotheses: list[ShortText] = Field(default_factory=list, max_length=8)
    unknowns: list[ShortText] = Field(default_factory=list, max_length=8)
    candidate_files: list[RelPath] = Field(default_factory=list, max_length=16)


class PlanStep(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^step-\d{1,3}$")]
    description: ShortText
    files: list[RelPath] = Field(default_factory=list, max_length=16)
    verification: list[ShortText] = Field(default_factory=list, max_length=8)


class Plan(Strict):
    objective: ShortText
    assumptions: list[ShortText] = Field(default_factory=list, max_length=10)
    steps: list[PlanStep] = Field(min_length=1, max_length=12)
    files_to_modify: list[RelPath] = Field(default_factory=list, max_length=32)
    tests: list[ShortText] = Field(default_factory=list, max_length=12)
    risks: list[ShortText] = Field(default_factory=list, max_length=10)
    out_of_scope: list[ShortText] = Field(default_factory=list, max_length=10)


class MigrationStep(PlanStep):
    rollback: ShortText


class AffectedArea(Strict):
    area: ShortText
    description: ShortText
    files: list[RelPath] = Field(default_factory=list, max_length=16)
    evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=8)


class MigrationPlan(Strict):
    """Plan-only migration workflow: ordered steps each with a rollback, the affected areas with the
    evidence that shows them, prerequisites and an overall rollback strategy. Nothing is executed."""

    objective: ShortText
    assumptions: list[ShortText] = Field(default_factory=list, max_length=10)
    steps: list[MigrationStep] = Field(min_length=1, max_length=12)
    files_to_modify: list[RelPath] = Field(default_factory=list, max_length=32)
    tests: list[ShortText] = Field(default_factory=list, max_length=12)
    risks: list[ShortText] = Field(default_factory=list, max_length=10)
    out_of_scope: list[ShortText] = Field(default_factory=list, max_length=10)
    affected_areas: list[AffectedArea] = Field(default_factory=list, max_length=12)
    prerequisites: list[ShortText] = Field(default_factory=list, max_length=8)
    rollback_strategy: list[ShortText] = Field(default_factory=list, max_length=8)


class FileChange(Strict):
    path: RelPath
    action: Literal["modify", "create", "delete"]
    # Full new file content for modify/create (validated and diffed by the control plane).
    content: str | None = Field(default=None, max_length=200_000)
    explanation: ShortText


class PatchProposal(Strict):
    summary: ShortText
    changes: list[FileChange] = Field(min_length=1, max_length=32)
    plan_revision_needed: bool = False


class ReviewFinding(Strict):
    severity: Literal["info", "low", "medium", "high", "critical"]
    file_path: RelPath
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    title: ShortText
    rationale: LongText
    evidence: list[ShortText] = Field(default_factory=list, max_length=6)
    confidence: Literal["low", "medium", "high"]
    suggested_action: ShortText | None = None


class Review(Strict):
    summary: LongText
    findings: list[ReviewFinding] = Field(default_factory=list, max_length=20)


class VerificationSummary(Strict):
    summary: LongText
    likely_causes: list[ShortText] = Field(default_factory=list, max_length=6)
    suggested_next_steps: list[ShortText] = Field(default_factory=list, max_length=6)


OUTPUT_SCHEMAS: dict[str, type[BaseModel]] = {
    "repository_qa": QaAnswer,
    "investigation": Investigation,
    "planning": Plan,
    "migration_plan": MigrationPlan,
    "patch": PatchProposal,
    "repair": PatchProposal,
    "review": Review,
    "verification_summary": VerificationSummary,
}
