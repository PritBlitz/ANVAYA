# Application secrets. Generated ones are created here; GitHub App credentials are provider-issued
# and must be put in place before the first deploy:
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string file://...
# Services read every secret at start through ECS `secrets` / the execution host bootstrap.
# Nothing here is ever sent to the browser (CLAUDE.md §8).

resource "random_password" "ai_service_token" {
  length  = 48
  special = false
}

resource "random_password" "metrics_token" {
  length  = 48
  special = false
}

locals {
  generated_secrets = {
    "ai-service-token" = random_password.ai_service_token.result
    "metrics-token"    = random_password.metrics_token.result
    # The full URL carries the AUTH token; TLS is mandatory (rediss).
    "redis-url" = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379/0"
  }
  provided_secrets = toset([
    "github-app-id",
    "github-app-private-key",
    "github-webhook-secret",
    "github-oauth-client-id",
    "github-oauth-client-secret",
  ])
}

resource "aws_secretsmanager_secret" "generated" {
  for_each   = local.generated_secrets
  name       = "${local.prefix}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each      = local.generated_secrets
  secret_id     = aws_secretsmanager_secret.generated[each.key].id
  secret_string = each.value
}

resource "aws_secretsmanager_secret" "provided" {
  for_each   = local.provided_secrets
  name       = "${local.prefix}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}

locals {
  secret_arns = merge(
    { for k, s in aws_secretsmanager_secret.generated : k => s.arn },
    { for k, s in aws_secretsmanager_secret.provided : k => s.arn },
  )
  # RDS-managed master password, rotated by RDS. Exposed to the app as PGPASSWORD, which
  # node-postgres uses when DATABASE_URL carries no password.
  db_password_ref = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:password::"
  database_url    = "postgres://anvaya@${aws_db_instance.postgres.address}:5432/anvaya?sslmode=verify-full"
}
