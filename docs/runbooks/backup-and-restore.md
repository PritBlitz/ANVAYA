# Runbook: backup and restore

Scope: PostgreSQL (all product state: workspaces, repositories, runs, approvals, audit), shared
artifact storage (`STORAGE_DIR`: snapshots, run artifacts) and Redis (queues; disposable).

| Store | Primary protection | Portable copy | RPO | RTO target |
|---|---|---|---|---|
| PostgreSQL (RDS) | Automated backups + point-in-time recovery (7 days staging, 30 production) | `scripts/ops/pg-backup.sh` archive (daily, kept off-account) | ≤ 5 min (PITR) | 1 h |
| Artifact storage (EFS) | AWS Backup (enabled by `infra/aws`) | — | 24 h | 2 h |
| Redis | Not backed up by design: queues are rebuilt from Postgres state | — | n/a | minutes |

Runs are durable in Postgres (`workflow_runs`, checkpoints, transitions), so losing Redis loses
only in-flight queue entries; the worker resumes runs from their last committed checkpoint.

## Portable backup (any environment)

```sh
DATABASE_URL=postgres://anvaya@<host>:5432/anvaya PGPASSWORD=... \
  scripts/ops/pg-backup.sh /backups/anvaya
```

Produces `anvaya-<UTC timestamp>.dump` (pg_dump custom format, no owners/ACLs), a `.rows` manifest
with every table's row count, and a `.sha256` file covering both. Store all three together,
encrypted, outside the production account.

## Restore and verify

```sh
createdb -h <host> -U anvaya anvaya_restored          # must be EMPTY
scripts/ops/pg-restore.sh /backups/anvaya/anvaya-<ts>.dump postgres://anvaya@<host>:5432/anvaya_restored
```

The script refuses to run if the checksum does not match or the target already has tables, creates
the `vector` and `pgcrypto` extensions, restores in a single transaction, and fails unless every
table's row count matches the manifest. Then point `DATABASE_URL` at the restored database and
restart the API and worker; migrations are checksum-protected and will refuse a mismatched schema.

**Tested 2026-11-03** against the local development database: a 6.7 MB archive of 33 tables
restored with matching row counts; a non-empty target and a tampered archive were both refused.
Repeat this restore drill at least quarterly and after every schema migration that changes data.

## Point-in-time recovery on AWS (RDS)

1. Pick the timestamp just before the incident (audit events help: `GET /workspaces/:id/audit-events?to=`).
2. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier anvaya-production --target-db-instance-identifier anvaya-production-pitr --restore-time <ISO-8601> --db-subnet-group-name anvaya-production --vpc-security-group-ids <db sg>`
3. Verify with read-only queries (row counts, latest `audit_events.created_at`), then switch the
   services to the new endpoint (update `DATABASE_URL` in Terraform or rename the instances) and redeploy.
4. Keep the original instance until the restored one has served traffic for a day.

## Artifact storage (EFS)

Restore a recovery point from AWS Backup to a new file system, mount it on one execution host to
check `STORAGE_DIR` contents, then point `aws_efs_file_system.storage` at it. Missing artifacts never
corrupt state: snapshots are re-created by re-indexing, and run artifacts are re-produced by retrying runs.
