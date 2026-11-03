# ANVAYA — Product Evolution and Release Roadmap

**Document type:** Product evolution roadmap  
**Purpose:** Defines how the complete product is built through independently scoped releases. The canonical product definition remains in `PRD.md`.

## 1. Release philosophy

The product vision is broader than any single release. Each release is a deliberate, testable subset of the canonical product.

Release planning must:
- Preserve security and human approval requirements.
- Deliver a usable vertical slice early.
- Validate product assumptions with real repositories and developers.
- Measure retrieval and engineering quality rather than relying on demos.
- Keep local-only inference and mock mode available.
- Avoid expanding language/provider support before core reliability is established.

## 2. Product capability progression

### Foundation
Identity, workspaces, GitHub integration, repository snapshots, indexing, local model provider, retrieval, and observability.

### Engineering intelligence
Repository Q&A, architecture understanding, issue investigation, plans, code citations, and knowledge capture.

### Controlled engineering execution
Patch generation, sandboxed tests, bounded repair, review, human approvals, and pull-request handoff.

### Team and enterprise capabilities
Role policies, governance, workflow templates, advanced audit, integrations, multi-provider support, retention controls, and enterprise deployment patterns.

### Advanced intelligence
Deeper dependency/call graphs, cross-repository knowledge, change impact prediction, test selection, migration planning, and organization-level engineering knowledge.

## 3. Six-month implementation program

This program is a recommended path to a strong first production-oriented release. Exact release scope is finalized through release planning.

### Phase 0 — Product and engineering foundation (Week 1)
- Review canonical product documents.
- Resolve open technology decisions.
- Create monorepo and coding standards.
- Set up local Postgres/Redis/Ollama.
- Establish CI, test, lint, formatting, and migrations.
- Create architecture decision records.

Exit criteria:
- Clean clone can start local dependencies.
- CI runs checks.
- No real secrets are committed.
- Local mock provider works.

### Phase 1 — Identity, workspace, and GitHub (Weeks 2–4)
- Authentication.
- Workspace and membership model.
- NestJS modules.
- GitHub App installation.
- Repository metadata sync.
- Webhook signature validation and idempotency.
- Repository selection UI.

Exit criteria:
- User connects a test repository.
- Workspace authorization tests pass.
- Webhook replay/forgery tests pass.

### Phase 2 — Repository intelligence foundation (Weeks 5–8)
- Snapshot ingestion.
- File filtering and size limits.
- Tree-sitter parsing for TypeScript/JavaScript and Python.
- Symbol extraction.
- Line-aware chunking.
- Local embeddings.
- pgvector and lexical retrieval.
- Index health and coverage UI.

Exit criteria:
- Repository indexes asynchronously.
- Incremental updates work for changed files.
- Search returns path, line, commit, and content hash.
- Excluded/secret files are not embedded.

### Phase 3 — Grounded engineering knowledge (Weeks 9–10)
- FastAPI provider service.
- Ollama adapter and mock adapter.
- Hybrid retrieval and evidence packs.
- Repository Q&A.
- Source citations.
- Token/context budgets.
- Prompt injection fixtures.

Exit criteria:
- Answers cite indexed evidence.
- Unsupported claims are qualified.
- Local mode makes no hosted inference request.
- CI runs without model API credits.

### Phase 4 — Task planning and approval (Weeks 11–13)
- Task creation from manual request and GitHub issue.
- Durable workflow state machine.
- Investigation and planner stages.
- Structured plan schema.
- Plan editor and approval.
- SSE timeline.
- Cancellation and retry.

Exit criteria:
- Run state survives worker restart.
- Invalid plan output is rejected.
- No code modification occurs before plan approval.
- Events can reconnect/replay.

### Phase 5 — Controlled patch execution (Weeks 14–17)
- Execution service.
- Disposable sandbox.
- Patch validation.
- Branch/workspace handling.
- Allowlisted test/lint/build profiles.
- Resource and egress controls.
- Verification artifacts.
- Bounded repair.

Exit criteria:
- Model cannot invoke arbitrary shell.
- Sandbox cannot access control-plane services or host secrets.
- Test results reflect real exit codes.
- Timeout/cancellation cleans up execution.

### Phase 6 — Review and pull-request handoff (Weeks 18–20)
- Diff viewer.
- Reviewer stage.
- Static/security scanner integration.
- Evidence-backed findings.
- PR approval gate.
- GitHub branch/commit/PR creation.
- Audit trail.

Exit criteria:
- Findings cite changed lines/evidence.
- PR creation cannot bypass approval.
- Approval is bound to reviewed patch hash.
- Duplicate external writes are prevented.

### Phase 7 — Production hardening and evaluation (Weeks 21–22)
- Budgets and quotas.
- OpenTelemetry.
- Structured logs and redaction.
- Rate limits and retention.
- Retrieval and workflow benchmarks.
- Security testing.
- Backup/recovery and runbooks.

Exit criteria:
- Runaway tasks are bounded.
- Metrics expose queue, model, sandbox, and failure behavior.
- Security test suite passes.
- Evaluation methodology and results are documented.

### Phase 8 — Deployment and public portfolio release (Weeks 23–24)
- Production-like deployment.
- CI/CD and environment separation.
- Operational documentation.
- Demo repository and walkthrough.
- Architecture case study.
- Known limitations and roadmap.

Exit criteria:
- Deployment is reproducible.
- Health checks and rollback tested.
- End-to-end demo completes with human-approved PR.
- Documentation matches actual behavior.

## 4. Release definition template

Every release should create its own file, e.g. `releases/V1.md`, containing:
- Release goal and target user.
- Included capabilities mapped to PRD requirement IDs.
- Explicit exclusions.
- User stories and acceptance criteria.
- API/database changes.
- Security and privacy impact.
- Migration and rollback plan.
- Test plan and evaluation thresholds.
- Documentation and support plan.
- Release exit criteria.

Do not turn this canonical roadmap into a detailed ticket backlog until the product documents and architecture decisions have been reviewed.

## 5. Prioritization rules

When schedule pressure occurs, preserve this order:
1. Authorization and data isolation.
2. Repository indexing and grounded retrieval.
3. Durable task/run state.
4. Human plan approval.
5. Isolated patch execution.
6. Deterministic verification.
7. Review evidence.
8. Human PR approval and Git integration.
9. Advanced visualization and analytics.
10. Additional languages and providers.

Never cut sandbox isolation, tenant authorization, or approval gates to meet a date.

## 6. Definition of done

A capability is complete when:
- Acceptance criteria pass.
- Automated tests exist.
- Authorization is enforced.
- Failure and cancellation paths are handled.
- Logs and metrics are present.
- Sensitive data is redacted.
- Documentation is updated.
- No silent paid inference dependency exists.
- Security implications are reviewed.
