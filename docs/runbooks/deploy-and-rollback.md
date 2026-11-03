# Runbook: deploy and roll back

## Release

1. CI must be green on `main` (backend-ci: API, AI service, real-gVisor probes, images, Terraform;
   web-ci: checks and E2E in Chromium, Firefox and WebKit).
2. Build and push `web`, `api`, `ai-service` images tagged with the commit SHA (ECR tags are immutable).
3. `terraform plan -var-file=environments/<env>.tfvars -var image_tag=<sha>` and review it. Expect only
   task-definition and launch-template changes for an application release.
4. `terraform apply` the reviewed plan. The API task runs pending migrations before it serves.
5. Watch: ALB target health, `api-5xx` and `*-unhealthy` alarms, `GET /api/v1/health/ready`.

Database migrations are forward-only and checksum-protected: an applied migration is never edited
(CLAUDE.md §7). Write each migration so that the previous application version still works against
the new schema (expand, deploy, then contract in a later release); that is what keeps rollback safe.

## Automatic rollback

- **ECS services** use the deployment circuit breaker with rollback: if new tasks fail health checks,
  ECS returns the service to the last steady task definition on its own.
- **Execution hosts** are replaced by an instance refresh with `auto_rollback`: a failed refresh
  returns the group to the previous launch template version.

## Manual rollback

```sh
terraform apply -var-file=environments/<env>.tfvars -var image_tag=<previous sha>
```

The last 30 images stay in ECR. If a release included a migration, roll back the application only
when the previous version is compatible with the new schema (see above); otherwise restore the
database (`backup-and-restore.md`) to just before the deploy.

## After any rollback

Record the incident, keep the failed image for analysis, and add a regression test before
re-releasing.

## Production-like local deployment (tested)

`infra/compose/docker-compose.prod.yml` runs the same images with production configuration (no dev
login, secure cookies, AI service token, no container sandbox) and its own data stores.

```sh
tag=$(scripts/deploy/build-images.sh)     # anvaya-{api,ai-service,web}:<commit>
scripts/deploy/deploy.sh "$tag"           # waits for health, smoke-tests through the web origin
```

`deploy.sh` records the deployed tag in `.deploy/current`. If the new tag fails its health checks
or the smoke test, it redeploys the previous tag, re-verifies it, and exits 1.

**Tested 2026-11-03:** release `d5fd1dc88a09` deployed with all six services healthy; in
production mode the dev-login route does not exist, `/api/v1/internal/metrics` is hidden, and the
API has no published port. A deliberately broken release (the API crashes on start) was detected as
unhealthy and rolled back automatically to `d5fd1dc88a09`, which then served `/login` and the
proxied readiness check with 200.
