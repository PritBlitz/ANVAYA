# Architecture case study: Anvaya

Anvaya connects repository understanding to evidence-backed code changes, and only hands a change
to GitHub after a person approves it. This document explains how the architecture enforces that,
what was measured, and what broke on the way.

## The shape of the system

```
Browser ──► Next.js web (same-origin /api/v1 proxy, CSP, no secrets)
              │
              ▼
          NestJS control plane ──► PostgreSQL + pgvector (all durable state, append-only audit)
              │        │      └──► Redis + BullMQ (queues, rate limits, SSE fan-out)
              │        └──► GitHub App (short-lived, repository-scoped installation tokens)
              ▼
          Worker (same image) ── orchestration state machine ──► FastAPI AI service ──► Ollama (default)
              │                                                     └──► hosted Claude (opt-in only)
              ▼
          Execution plane: gVisor (runsc) per check, no network, read-only root, non-root
```

## Decisions that carry the guarantees

| Guarantee | Mechanism |
|---|---|
| Evidence before assertion | Retrieval is deterministic (no LLM); every investigation finding and Q&A citation carries an evidence id resolved to file and line; Q&A refuses when evidence is missing |
| Human approval before a PR | Plan approval bound to the plan hash, PR approval bound to the patch hash; an agent can never approve its own work; success is shown only after GitHub confirms |
| Durable, observable workflow | An explicit state machine in Postgres (ADR-0001) with optimistic concurrency, an outbox of run events, checkpoints for crash recovery, SSE with replay |
| Untrusted repository content | Repository text, issues, PR comments and check output enter prompts only as labelled untrusted data; outputs are schema-validated; no shell tool exists for the model |
| Isolated execution | Server-defined command profiles only; gVisor sandbox (ADR-0002) with no network, read-only root, no capabilities, resource limits; egress allowlist on AWS |
| Local inference by default | Ollama is the default; hosted providers need workspace opt-in with disclosure of provider and data categories, and there is no silent fallback |
| Tenant isolation | Every query is scoped by verified membership; non-members get 404 on every workspace route, enforced by an OpenAPI-driven security suite |

## What was measured

- **Retrieval** (`docs/evaluations/retrieval.md`): 25 labelled questions over the API's own code.
  The benchmark exposed prefix-matched stop words swamping lexical ranking; the fix raised lexical
  recall@10 from 0.52 to 0.60 and hybrid from 0.72 to 0.76.
- **Workflow** (`docs/evaluations/workflow.md`): local `qwen2.5-coder:7b` on CPU takes 3–8 minutes to
  investigate and 5–6 to plan; a full run needs about 15–25 minutes of model time.
- **Sandbox**: seven hostile probes run against real gVisor in CI on every backend change — no
  network, unwritable root, no exec from `/tmp`, no host environment, fork bomb contained, wall-clock
  kill, and the guest kernel reported as gVisor.

## What broke, and what it taught

Running the real stack end to end — not just the test suites — found the bugs that mattered:

1. **Timeouts stacked below the policy.** A 30 s proxy default in Next.js and a 300 s header timeout
   in Node's `fetch` each silently capped calls the policy allowed to run 580 s. Lesson: every hop
   needs an explicit deadline, and the policy deadline must be the only one that fires.
2. **A budget that measured people.** The run-duration budget counted time spent waiting for a human
   to approve, so a careful reviewer caused a timeout. Budgets now count agent work only.
3. **gVisor starved itself.** The host PID cgroup also contains gVisor's own threads; at the guest's
   limit the sandbox crashed instead of refusing a fork. Guests are now limited inside the sandbox
   (RLIMIT_NPROC) and the cgroup keeps headroom as a backstop.
4. **Wall clocks are not orderings.** Docker Desktop's VM clock steps on resync; ordering "latest job"
   by `created_at` flaked one run in three. Insertion order now comes from an identity column.
5. **A clean checkout is the real test.** Generated Next.js types and a root-only CA bundle passed
   locally and failed in CI. CI now builds the images and checks them as the runtime user.

## Deployment

A production-like compose stack with immutable tags, health checks and automatic rollback (tested by
deploying a deliberately broken release), and a Terraform reference deployment for AWS: ECS Fargate
for web/API/AI, gVisor hosts behind an AWS Network Firewall domain allowlist, RDS (pgvector), Redis
with TLS and AUTH, EFS, Secrets Manager, alarms. Validated in CI; not applied.

## Known limitations

See `docs/known-limitations.md`.
