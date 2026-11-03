# ANVAYA — Product Requirements & Product Definition

**Document type:** Canonical product definition  
**Product identity:** Anvaya — AI-native software engineering intelligence and execution platform  
**Audience:** Product, engineering, design, security, QA, and AI coding agents  
**Authority:** This document defines the complete intended product. Release plans (V1, V2, etc.) are derived from it; they do not redefine the product vision.

---

## 1. Product identity

### 1.1 Name and meaning

**Anvaya** is derived from Sanskrit and conveys connection, relation, continuity, and coherent sequence. The name reflects the product's central purpose: understanding how parts of a software system connect, then coordinating a traceable path from engineering intent to a verified change.

The product name is subject to domain, company-name, and trademark clearance before public commercial use.

### 1.2 Product category

AI-native software engineering intelligence and execution platform.

### 1.3 Product statement

Anvaya connects to a software repository, builds a structured understanding of its code and engineering context, and helps developers investigate, plan, implement, verify, review, and document changes through bounded AI workflows and deterministic engineering tools.

### 1.4 One-line positioning

**From codebase understanding to evidence-backed engineering change.**

### 1.5 Product promise

Anvaya does not merely generate code. It makes AI-assisted engineering work inspectable: what was examined, what was proposed, what changed, which checks ran, what passed, what failed, and what a human approved.

---

## 2. Product vision

Software systems are increasingly complex, while engineering teams are expected to ship reliable changes quickly. Developers must understand unfamiliar code, trace dependencies, reproduce defects, evaluate risks, write tests, review changes, and preserve architectural knowledge.

Anvaya aims to become an engineering workspace that understands a codebase as a connected system rather than a collection of files. It combines repository intelligence, engineering workflows, AI-assisted reasoning, controlled execution, verification evidence, and human governance.

The long-term product is a trusted engineering layer between a developer's intent and a change to a software system.

## 3. The problem

### 3.1 User problems

1. **Codebase discovery:** Understanding an unfamiliar or large repository takes time.
2. **Fragmented context:** Issues, code, tests, architecture docs, pull requests, and decisions are spread across tools.
3. **Unreliable AI edits:** Generated code may be plausible but incorrect, incomplete, insecure, or incompatible with project conventions.
4. **Weak verification:** A model may claim a fix works without running meaningful checks.
5. **Review burden:** Reviewers must reconstruct why files changed and whether evidence supports the change.
6. **Loss of engineering knowledge:** Decisions and dependencies are difficult to discover later.
7. **Cost and privacy constraints:** Hosted AI can be expensive and may be inappropriate for private source code.

### 3.2 Product response

Anvaya creates a persistent, version-aware representation of repository structure and engineering evidence; uses that representation to ground AI work; executes changes in controlled environments; and presents verifiable results for human decisions.

---

## 4. Target users

### 4.1 Individual software developer
Needs to understand repositories, debug issues, implement scoped changes, and learn unfamiliar systems.

### 4.2 Engineering team member
Needs a consistent workflow for AI-assisted issue resolution with shared standards and reviewability.

### 4.3 Tech lead / maintainer
Needs visibility into change scope, architectural impact, test evidence, security concerns, and review status.

### 4.4 Engineering manager
Needs aggregate visibility into task throughput, bottlenecks, quality signals, model costs, and workflow adoption without treating metrics as individual productivity surveillance.

### 4.5 Workspace administrator / security owner
Needs to govern repository access, provider policies, execution permissions, retention, budgets, and audit trails.

---

## 5. Product principles

1. **Evidence before assertion:** Answers and findings should cite source files, line ranges, command outputs, or other traceable evidence.
2. **Human accountability:** AI proposes; authorized humans approve consequential actions.
3. **Deterministic verification:** Tests, builds, linters, and scanners—not model statements—determine their own outcomes.
4. **Least privilege:** Each integration, agent, and worker receives only the permissions required for its task.
5. **Local-first, provider-independent:** Local inference is a first-class mode; cloud inference is explicit and governed.
6. **Repository-aware, not repository-dumping:** Retrieve relevant code rather than sending entire repositories into model context.
7. **Bounded autonomy:** Every automated workflow has limits, checkpoints, timeouts, cancellation, and auditability.
8. **Transparent uncertainty:** The product communicates missing evidence, low confidence, unsupported languages, and failed checks.
9. **Composable workflows:** Features can be used independently; users are not forced into autonomous execution.
10. **Engineering-grade UX:** The interface should help users inspect and control work, not hide complexity behind a chat box.

---

## 6. Product scope and capability map

The complete product consists of the following capability domains.

### 6.1 Identity, workspace, and governance
- User authentication and session management.
- Organizations/workspaces and memberships.
- Roles and permission policies.
- Repository-level access controls.
- Provider policy and budget controls.
- Audit history and administrative settings.

### 6.2 Source-control integrations
- GitHub App integration as the primary provider.
- Repository selection and metadata synchronization.
- Issue, pull-request, branch, commit, and webhook context.
- Short-lived installation tokens.
- Later provider adapters for GitLab and Bitbucket without changing core domain concepts.

### 6.3 Repository intelligence
- Repository snapshot and commit awareness.
- Language and file classification.
- Ignore/exclusion rules.
- Syntax-tree parsing.
- Symbol, import, call/reference, and dependency relationships where supported.
- Line-aware code chunking.
- Lexical and semantic retrieval.
- Repository architecture maps and module summaries.
- Version-aware re-indexing.
- Source citations with commit SHA and line range.
- Repository question answering.

### 6.4 Engineering knowledge
- Architecture documents and repository documentation indexing.
- Issue and pull-request context.
- Decision records and engineering notes.
- Relationship between modules, symbols, tests, issues, and changes.
- Search across repository evidence and engineering history.
- Provenance for each indexed item.

### 6.5 AI-assisted engineering
- Issue understanding and clarification.
- Repository investigation.
- Implementation planning.
- Plan critique and risk identification.
- Code patch generation.
- Test suggestion and test generation.
- Bounded repair attempts.
- Code review and change explanation.
- Documentation updates.
- Migration and refactoring assistance.
- Multi-step workflows with persisted state.

### 6.6 Controlled execution
- Disposable workspaces.
- Branch and commit management.
- Patch validation.
- Allowlisted test/lint/build profiles.
- Resource, time, process, disk, and output limits.
- Network policy.
- Artifact and log collection.
- Cleanup and recovery.

### 6.7 Verification and governance
- Test and build result capture.
- Static analysis and security scanner results.
- Diff review.
- Risk and impact summaries.
- Human plan approval.
- Human pull-request approval.
- Audit trail.
- Evidence-backed verification report.
- No automatic merge or production deployment by default.

### 6.8 Observability and economics
- Agent stage traces.
- Tool-call logs.
- Latency and failure rates.
- Token and estimated cost tracking.
- Local versus hosted inference visibility.
- Workspace and per-run budgets.
- Provider quotas and rate-limit handling.

### 6.9 Extensibility
- Model provider adapters.
- Embedding and reranking adapters.
- Language parser adapters.
- Git provider adapters.
- Tool registry with permission scopes.
- Workflow templates.
- Webhook/event integrations.

---

## 7. Core product experiences

### 7.1 Repository onboarding
A user connects a GitHub organization or account, chooses repositories, reviews requested permissions, and starts indexing. The interface shows commit, language coverage, excluded paths, indexing progress, and any parsing limitations.

### 7.2 Repository exploration
A user browses a file tree, searches symbols and code, views module relationships, asks questions, and opens citations at the relevant commit and line range.

### 7.3 Engineering investigation
A user starts from an issue, pull request, failing test, or free-text problem. Anvaya gathers evidence, identifies relevant modules, explains likely causes, and surfaces uncertainties.

### 7.4 Plan and approval
Anvaya proposes a structured implementation plan: objectives, assumptions, affected files, steps, risks, tests, and expected behavior. The user can edit, approve, or reject it.

### 7.5 Implementation
After approval, Anvaya creates a disposable workspace and branch. The developer workflow proposes changes within the approved scope. Every file change is recorded.

### 7.6 Verification
Anvaya executes configured commands in a sandbox, captures actual results, and presents failures and artifacts. A bounded repair loop may be enabled.

### 7.7 Review
A reviewer workflow examines the actual diff, relevant surrounding code, tests, and static analysis. Findings include severity, file/line, rationale, evidence, and uncertainty.

### 7.8 Pull-request handoff
An authorized user reviews the full change and explicitly approves PR creation. Anvaya creates a branch/commit/PR using the Git provider integration and includes a summary of changes and verification evidence.

### 7.9 Knowledge capture
Completed runs can produce durable engineering notes: root cause, decision, affected modules, tests, and follow-up work. Users control whether these notes are retained and indexed.

---

## 8. Functional requirements

Requirements below define the full intended product. They are not a promise that every capability belongs in the first release. Release scope is derived in `ROADMAP.md`.

### 8.1 Identity and governance
- FR-ID-001: Users can authenticate and manage sessions.
- FR-ID-002: Users can create and belong to workspaces.
- FR-ID-003: Workspace roles include owner, admin, member, and viewer.
- FR-ID-004: Authorization is enforced server-side for every tenant-owned resource.
- FR-ID-005: Administrators can configure provider policies, budgets, retention, and execution policies.
- FR-ID-006: Security-sensitive actions create audit events.
- FR-ID-007: Users can revoke sessions and integrations.

### 8.2 Git integrations
- FR-GIT-001: GitHub App is the first supported provider.
- FR-GIT-002: Users can select repositories from authorized installations.
- FR-GIT-003: The platform uses short-lived installation tokens.
- FR-GIT-004: Webhooks are signature-verified and idempotent.
- FR-GIT-005: Repository metadata and default branch state are synchronized.
- FR-GIT-006: Issues and PRs can be imported as task context.
- FR-GIT-007: Branches, commits, and PRs can be created only under configured permissions and approvals.
- FR-GIT-008: Disconnecting an installation stops future access and indexing.

### 8.3 Repository intelligence
- FR-REP-001: Repositories are indexed asynchronously and by commit SHA.
- FR-REP-002: File exclusion rules cover binaries, dependencies, build output, generated code, secrets, and configured paths.
- FR-REP-003: Supported files are parsed into syntax-aware structures.
- FR-REP-004: Symbols and relationships are extracted where parser support permits.
- FR-REP-005: Chunks retain source path, line range, commit SHA, content hash, language, and parser version.
- FR-REP-006: Retrieval supports lexical, semantic, and metadata filtering.
- FR-REP-007: Search results expose source citations and provenance.
- FR-REP-008: Indexing supports incremental updates and invalidation.
- FR-REP-009: The product displays coverage and known limitations.
- FR-REP-010: Repository Q&A refuses to invent citations when evidence is missing.

### 8.4 Engineering workflows
- FR-WF-001: A task can originate from an issue, PR, failing check, or manual request.
- FR-WF-002: A run has durable status, stage, events, checkpoints, and budgets.
- FR-WF-003: Investigation returns evidence and unresolved questions.
- FR-WF-004: Planning returns a schema-valid implementation plan.
- FR-WF-005: Users can approve, edit, or reject plans.
- FR-WF-006: Code modification is scoped to an approved task and isolated workspace.
- FR-WF-007: All patches are validated before application.
- FR-WF-008: The workflow supports cancellation, timeout, retry, and safe recovery.
- FR-WF-009: Repair attempts are bounded by policy.
- FR-WF-010: Workflows can be run in dry-run mode with mocked model responses.

### 8.5 Verification and review
- FR-VER-001: Commands run only through server-defined execution profiles.
- FR-VER-002: Results include exact command profile, exit code, duration, and bounded output.
- FR-VER-003: Review findings reference actual diff locations and evidence.
- FR-VER-004: AI review findings are clearly distinguished from deterministic scanner findings.
- FR-VER-005: Verification reports show passed, failed, skipped, and unavailable checks separately.
- FR-VER-006: A numeric confidence score, if ever displayed, must be explainable and must not imply correctness guarantees.
- FR-VER-007: PR creation requires an authorized human approval.

### 8.6 AI and provider management
- FR-AI-001: Model providers are accessed through a common adapter.
- FR-AI-002: Ollama is supported for local inference.
- FR-AI-003: Hosted providers are opt-in and governed by workspace policy.
- FR-AI-004: No silent paid fallback is permitted.
- FR-AI-005: Token, context, time, step, and cost budgets are enforced.
- FR-AI-006: Prompts and tool outputs are versioned and traceable.
- FR-AI-007: Structured model outputs are schema-validated.
- FR-AI-008: Cloud inference requires disclosure of provider and data categories transmitted.
- FR-AI-009: Provider failures pause or fail workflows gracefully.

### 8.7 Observability
- FR-OBS-001: Users can inspect run timeline and agent stage outcomes.
- FR-OBS-002: Authorized users can inspect tool traces and redacted logs.
- FR-OBS-003: The system tracks latency, errors, retries, token use, and cost estimates.
- FR-OBS-004: Admins can configure quotas and concurrency limits.
- FR-OBS-005: Audit logs are searchable by time, actor, action, and resource.

---

## 9. Non-functional requirements

### Security
- Tenant isolation and least privilege.
- Signed webhook validation.
- Secure secret storage and redaction.
- Sandboxed execution with hardened isolation.
- Deny-by-default sandbox network access.
- Prompt-injection-aware tool design.
- Explicit human approval for consequential writes.

### Reliability
- Durable run state in PostgreSQL.
- Idempotent jobs and external side effects.
- Retry only transient failures.
- Dead-letter visibility.
- Cancellation propagation and cleanup.
- Recovery from worker restarts.

### Performance
- Indexing and AI workflows are asynchronous.
- Search latency is measured independently from model generation.
- UI streams progress without waiting for completion.
- Context packs are bounded by token budgets.
- Worker concurrency is configurable.

### Privacy
- Local-only mode keeps model inference local.
- Cloud mode is opt-in.
- Secrets are excluded from indexing and prompts.
- Retention and deletion controls are available.
- Data provenance is retained.

### Maintainability
- Typed contracts and schema validation.
- Explicit migrations.
- Modular backend boundaries.
- Automated tests and CI.
- Architecture decision records for significant changes.

### Accessibility and usability
- Keyboard-accessible core workflows.
- Clear loading, empty, error, and permission states.
- Explainable actions and approvals.
- Users can inspect and override plans before execution.

---

## 10. Product information architecture

Primary navigation:
1. Home / Overview
2. Repositories
3. Knowledge / Architecture
4. Tasks
5. Runs
6. Reviews
7. Usage and observability
8. Workspace settings

Repository workspace:
- Overview and indexing health.
- File tree and symbol explorer.
- Dependency/module map.
- Search and repository Q&A.
- Issues and tasks.
- Run history.

Run workspace:
- Task brief and accepted plan.
- Timeline and stage status.
- Retrieved evidence.
- Changed files and diff.
- Test/build/security results.
- Review findings.
- Approval and PR actions.

---

## 11. Product metrics

### Adoption
- Connected repositories per workspace.
- Weekly active developers.
- Repository questions per active repository.
- Tasks started and completed.

### Intelligence quality
- Retrieval precision@k.
- Citation correctness.
- Index coverage by language and file type.
- Repository question answer groundedness.

### Engineering quality
- Patch application success rate.
- Test pass rate.
- Defect detection precision and recall on seeded benchmarks.
- Human acceptance rate.
- Rework rate after PR.
- Repair-loop success rate.

### Operations
- Median and p95 indexing duration.
- Median and p95 run duration.
- Queue wait time.
- Cancellation completion time.
- Worker failure and cleanup rates.

### Economics
- Model tokens per task.
- Estimated inference cost per task.
- Sandbox compute per task.
- Provider quota utilization.
- Local versus hosted inference share.

Metrics are used to improve the product and workflows, not to make unsupported claims about individual developer productivity.

---

## 12. Product boundaries and explicit exclusions

Anvaya does not:
- Guarantee that AI-generated changes are correct or secure.
- Replace code owners, maintainers, or human review.
- Merge or deploy to production autonomously by default.
- Execute arbitrary user/model shell commands.
- Read secrets or production credentials to improve model context.
- Send private source code to hosted providers without explicit opt-in.
- Treat an LLM's confidence statement as proof.
- Claim support for languages or build systems that have not been tested.

---

## 13. Product release strategy

The product definition describes the complete intended system. Individual releases are controlled subsets of this definition.

- **V1:** Establish a trustworthy end-to-end workflow for selected repositories and languages.
- **V1.x:** Improve indexing, retrieval, reliability, security, evaluation, and developer experience.
- **V2:** Expand team workflows, knowledge graph capabilities, integrations, and supported languages.
- **V3+:** Add advanced engineering intelligence, workflow customization, enterprise governance, and broader ecosystem support.

Each release must have its own scope, acceptance criteria, migration plan, and release notes. Do not weaken the canonical product definition to fit a release schedule.
