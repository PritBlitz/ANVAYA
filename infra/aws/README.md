# AWS reference deployment (Terraform)

Infrastructure as code for running Anvaya on AWS (ROADMAP Phase 8, `releases/V1.md`). CI checks
it with `terraform fmt`, `init -backend=false` and `validate` on every change; **it has never been
applied** — no AWS account is wired to this repository.

## What it builds

| Tier | Resources |
|---|---|
| Network | VPC across two AZs: public (ALB, NAT), application, execution and firewall subnets; S3 gateway endpoint; VPC flow logs of rejected traffic |
| Edge | Public ALB, TLS 1.3 policy, HTTP→HTTPS redirect, `/api/v1/*` → API, `/api/v1/internal/*` blocked, everything else → web |
| Services | ECS Fargate: web, API (runs migrations then serves), AI service (private, via Cloud Map). Rolling deploys with the ECS circuit breaker and automatic rollback |
| Execution plane | EC2 hosts running the worker with **gVisor** (ADR-0002). IMDSv2 only (hop limit 1), no public IPs, no SSH (SSM only), unprivileged worker whose only privilege is `sudo -n /usr/bin/runsc`, sandbox images provisioned at boot from digest-pinned references |
| Egress control | AWS Network Firewall in front of the execution subnets: a domain allowlist (GitHub, npm, PyPI); everything else is dropped and logged (SECURITY §7 "strict egress proxy") |
| Data | RDS PostgreSQL 16 (pgvector) encrypted with a CMK, TLS enforced and verified (the API image ships the checksum-pinned RDS CA bundle), RDS-managed rotating master password, PITR backups (7 days staging / 30 days production), Multi-AZ and deletion protection in production; ElastiCache Redis 7 with TLS and AUTH; EFS (TLS + IAM access point) for `STORAGE_DIR` artifacts, with AWS Backup |
| Inference | Optional private Ollama hosts behind an internal NLB, reachable only from the AI service (local inference stays the default) |
| Secrets | Secrets Manager (CMK). Generated: AI service token, metrics token, Redis URL. Provided out of band: GitHub App credentials |
| Operations | CloudWatch log groups (CMK), SNS alarm topic, alarms for API 5xx, unhealthy targets, RDS CPU and storage, Redis memory, firewall drops |

## Environments

`environments/staging.tfvars` and `environments/production.tfvars` separate the two; production
turns on Multi-AZ, deletion protection, longer backups and per-AZ NAT. Use one state key each:

```sh
cat > environments/staging.backend.hcl <<EOF
bucket         = "<state-bucket>"
key            = "anvaya/staging.tfstate"
region         = "ap-south-1"
dynamodb_table = "<lock-table>"
encrypt        = true
EOF
terraform init -backend-config=environments/staging.backend.hcl
terraform plan  -var-file=environments/staging.tfvars -out=staging.plan
terraform apply staging.plan
```

## Deploy and roll back

1. Build and push `web`, `api`, `ai-service` images tagged with the git SHA to the ECR repositories
   (`terraform output ecr_repositories`). Tags are immutable.
2. Set the provided secrets once (`terraform output secrets_to_populate`).
3. `terraform apply -var image_tag=<sha>`: ECS rolls each service; a revision that fails health
   checks is rolled back automatically by the circuit breaker. Execution hosts are replaced by an
   instance refresh with `auto_rollback`.
4. Manual rollback: apply again with the previous `image_tag`. Images of the last 30 builds are kept.

## Before the first apply (known gaps)

- **Web image**: `apps/web` has no Dockerfile yet (it needs a standalone Next.js build in `http` mode).
- **Separate execution account**: SECURITY §7 recommends a separate account/VPC for the execution
  plane. This module isolates it by subnet, security group and egress firewall inside one VPC
  because the current worker both orchestrates (needs Postgres/Redis) and verifies. Splitting the
  sandbox controller out of the worker is the prerequisite for a separate account.
- **Independent security assessment** of the execution plane is still required before enabling broad
  public repository execution (SECURITY §7).
- **Traces**: `OTEL_TRACES_EXPORTER=none`; deploy an OTLP collector (e.g. ADOT) and set the
  exporter to enable traces. Metrics and structured logs work without it.
- The worker logs to journald on the execution hosts; ship them with the CloudWatch agent if needed.
