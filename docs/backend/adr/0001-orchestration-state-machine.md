# ADR-0001: Explicit persisted state machine in the control-plane worker (no LangGraph)

Status: accepted (backend session) · Date: 2026-11-02

## Context
ARCHITECTURE §4.5 allows LangGraph "if its checkpointing and state semantics fit", otherwise a
persisted explicit state machine; the product contract is the workflow behaviour. Run state,
authorization, budgets, approvals and audit all live in PostgreSQL owned by the NestJS control
plane. The AI service is designed to be stateless with no database access (ARCHITECTURE §4.3).

## Decision
Implement orchestration as an explicit state machine in TypeScript (`apps/api/src/runs`),
executed by the worker process. A single transition table defines legal moves; every transition
is an optimistic-concurrency update (`state_version`) written in the same transaction as its
`run_state_transitions` row and `run_events` (outbox) rows. Stage outputs are persisted in the
run checkpoint in that transaction, so a crashed worker resumes from the last committed stage.
The AI service remains a stateless structured-generation backend.

## Consequences
+ One source of truth; no second persistence layer or cross-service checkpoint format.
+ Authorization and approval gates are enforced in the same code that moves state.
+ Simple to test deterministically (mock provider, in-process orchestrator).
− Agent "graphs" are code rather than a framework graph; adding stages means adding handlers.
− Revisit if multi-agent branching/parallelism becomes a product need.

## Addendum (2026-11-03): plan-only runs

Work package B (releases/V1.md) adds a plan-only workflow (the built-in "migration plan" template,
or a workspace template with `workflow: migration_plan`). Its deliverable is the approved plan, so
the transition table gains one edge: `awaiting_plan_approval → completed_without_pr`. Only
`decidePlan` takes it, and only when the run's checkpoint records a plan-only template; every other
run still moves to `preparing_workspace`. The execution pipeline also refuses plan-only runs
(`PLAN_ONLY_WORKFLOW`) as a second guard. No other state, gate or approval changes: a plan-only run
never gets a workspace, a patch, a sandbox or a pull request.
