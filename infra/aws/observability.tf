resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(["web", "api", "ai", "worker"])
  name              = "/${var.name}/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/${var.name}/${var.environment}/vpc-flow-rejects"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "firewall" {
  name              = "/${var.name}/${var.environment}/egress-firewall"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

# CloudWatch Logs must be allowed to use the customer-managed key.
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key_policy" "data" {
  key_id = aws_kms_key.data.id
  policy = data.aws_iam_policy_document.kms.json
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.prefix}-alarms"
  kms_master_key_id = aws_kms_key.data.id
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    api-5xx = {
      namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 10, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.public.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
    }
    api-unhealthy = {
      namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.public.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
    }
    web-unhealthy = {
      namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.public.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
    }
    db-cpu = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
    }
    db-free-storage = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 5 * 1024 * 1024 * 1024, op = "LessThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
    }
    redis-memory = {
      namespace = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", stat = "Maximum", threshold = 80, op = "GreaterThanThreshold"
      dims      = { ReplicationGroupId = aws_elasticache_replication_group.redis.id }
    }
    egress-denied = {
      namespace = "AWS/NetworkFirewall", metric = "DroppedPackets", stat = "Sum", threshold = 100, op = "GreaterThanThreshold"
      dims      = { FirewallName = aws_networkfirewall_firewall.egress.name, AvailabilityZone = local.azs[0], Engine = "Stateful" }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "ops" {
  for_each            = local.alarms
  alarm_name          = "${local.prefix}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  dimensions          = each.value.dims
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
