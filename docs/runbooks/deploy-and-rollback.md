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
