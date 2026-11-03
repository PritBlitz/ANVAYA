# Runbook: incidents

Every action below is audited; never delete audit events (they are append-only by a database trigger).

## Model provider down or slow
Symptoms: runs fail with `PROVIDER_TIMEOUT` / `AI_SERVICE_UNAVAILABLE`; Q&A shows the provider message.
- There is **no silent fallback** (FR-AI-004): runs fail clearly and can be retried.
- Check the AI service (`/health/ready`) and Ollama (`/api/version`); on CPU, one loaded model and
  one concurrent request is the safe default (CLAUDE.md §11).
- Long local calls: raise the workspace's `request_timeout_seconds` (max 1800) and run budget in AI
  settings rather than changing code. Retry failed runs once the provider is healthy.

## Runs stuck in an active state
- Runs are durable: a restarted worker resumes from the last committed checkpoint. Check the worker
  is running and connected to Redis, then look at `GET /runs/:id/steps` and the run's transitions.
- Cancel with `POST /runs/:id/cancel`; cancellation propagates to the sandbox (runsc/docker kill).

## Suspected sandbox escape or abuse
1. Stop new execution: set `EXECUTION_DRIVER=disabled` on the worker (approved runs then fail with
   `EXECUTION_NOT_AVAILABLE`) and redeploy, or scale the execution group to zero.
2. Preserve evidence: snapshot the execution host volumes, export Network Firewall alert logs and
   VPC flow-log rejects, and the run's verification records.
3. Rotate everything the host could read: GitHub App private key, webhook secret, AI service token,
   metrics token, Redis AUTH token, and the RDS master password.
4. Replace the hosts (instance refresh) only after evidence is preserved.

## Leaked secret
Rotate it at the source (GitHub App settings, Secrets Manager), redeploy so services read the new
value, revoke user sessions if session-related (`DELETE /auth/sessions/:id`), and check the audit log
for use of the old credential. CI runs gitleaks on every push to catch committed secrets early.

## GitHub webhooks failing
Check the App's "Recent deliveries" in GitHub: `401` means the webhook secret is wrong; deliveries are
idempotent (stored in `webhook_deliveries`), so redelivering from GitHub is safe.

## Database pressure
Alarms `db-cpu` / `db-free-storage`. Storage autoscaling is enabled up to 4×. For CPU, check
slow-query logs (`log_min_duration_statement = 1s`) and large indexing jobs; pause re-indexing by
disconnecting the offending repository if needed.
