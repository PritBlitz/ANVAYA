# Database Notes

Tool: plain SQL migrations in `apps/api/migrations/NNNN_name.sql`, applied by
`src/database/migrator.ts` (one transaction per migration, advisory lock, SHA-256 checksums).
The migrator **refuses to run** if an applied migration changed or is missing on disk — add a
new migration instead. Tests reset `anvaya_test` and migrate from empty on every run.

| Migration | Contents |
|---|---|
| `0001_initial_schema.sql` | Canonical schema (`DATABASE.md` §4–5) + additions below |
| `0002_webhook_replay_and_jobs.sql` | Webhook payload-hash index; `indexing_jobs` |

## Deviations / additions to `DATABASE.md` (all additive)

| Change | Why |
|---|---|
| `sessions`, `workspace_invitations`, `idempotency_keys` | Auth, invitations and idempotency required by API_SPEC; not in the canonical model |
| `webhook_deliveries` (+ payload-hash index) | FR-GIT-004 idempotency and replay protection |
| `indexing_jobs` | Durable indexing state/progress/failures independent of Redis |
| `run_state_transitions` | ARCHITECTURE §6: every transition records actor, version, reason |
| `run_events` | Durable event log / outbox; SSE ids are its ids (replay) |
| `run_plans` | Versioned plans with content hashes; approvals bind to a hash |
| `approvals.subject_hash` | SECURITY §8: approvals bound to exact plan/patch hash |
| `repository_snapshots`: `failed_files`, `reused_files`, `embedding_model`, `embedding_dimension`, `base_snapshot_id`, `language_stats`, `error_summary`, `started_at`, `completed_at` | Honest coverage/limitations and incremental lineage |
| `repository_files.parse_status` | FR-REP-009 coverage reporting |
| `code_chunks`: `repository_id`, `snapshot_id`, `content_hash`, `language`, `search_vector` (generated tsvector) | Filter by tenant/repo/snapshot before ranking; lexical search |
| `code_chunks.embedding/_model/_version` **nullable** | A chunk stays lexically searchable if embedding fails; a CHECK requires model/version whenever an embedding is present |
| `workflow_runs`: `repository_id`, `snapshot_id`, `base_branch`, `created_by`, `retry_of_run_id`, `checkpoint`, `cancel_requested_at`, status CHECK | Durable resumable state, cancellation, retry lineage |
| `knowledge_documents.created_by` | Author-or-admin deletion |
| Composite FKs `engineering_tasks(repository_id, organization_id)` and `workflow_runs(task_id, organization_id)` | DATABASE §7: cross-tenant relationships are impossible at the DB level |
| `audit_events` append-only trigger | SECURITY §11: rows cannot be updated/deleted (FK nulling on parent deletion excepted) |
| `updated_at` triggers | Consistent timestamps |

## Semantics kept from the canonical schema (worth knowing)

* `git_installations.external_installation_id` and `repositories.external_repository_id` are
  globally UNIQUE: an installation/repository can be linked to **one** workspace at a time.
  Linking to a second workspace returns `409`.
* Repository disconnect keeps the `repositories` row (task/run/audit history) and deletes all
  snapshots → files → chunks/symbols, plus stored blobs.

## Vector index

`vector(768)` (e.g. `nomic-embed-text`). The API refuses to boot with a different
`EMBEDDING_DIMENSION`, and the AI service rejects mismatched vectors. Embeddings record model +
version (Ollama digest); a snapshot never mixes models. **No ANN index yet** (per DATABASE §5:
add HNSW after measuring volume); vector search is an exact scan filtered to one snapshot.

## Retention

Not yet implemented as a scheduled job (M8). Disconnect deletes index data and blobs immediately.

## Task sources and quotas (migration 0006)

* `engineering_tasks` gains `external_id text` (a GitHub check run id exceeds int4, so it is not
  stored in `external_number`), `source_url text` and `source_context jsonb` (bounded, redacted
  pull-request / failing-check metadata; untrusted content; capped at 128 KB by a CHECK). The
  `source_type` CHECK already allowed `pull_request` and `failing_check` (0001).
* Quotas live in `organizations.settings.run_quotas` (no new table). The daily run count uses the
  new `idx_runs_org_created` index; the daily token count sums `usage_records` since UTC midnight.
