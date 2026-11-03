output "public_url" {
  description = "Where users reach Anvaya (point DNS for public_hostname at alb_dns_name)."
  value       = local.public_url
}

output "alb_dns_name" {
  value = aws_lb.public.dns_name
}

output "github_webhook_url" {
  description = "Webhook URL to configure in the GitHub App."
  value       = "${local.public_url}/api/v1/webhooks/github"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "database_endpoint" {
  value = aws_db_instance.postgres.address
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "storage_file_system_id" {
  value = aws_efs_file_system.storage.id
}

output "secrets_to_populate" {
  description = "Provider-issued secrets to set before the first deploy."
  value       = [for k, s in aws_secretsmanager_secret.provided : s.name]
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
