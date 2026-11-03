# Strict egress for the execution plane (SECURITY §7): execution hosts reach only an allowlist of
# domains (GitHub for repository fetch and PR creation, package registries for the B-4 fetch step).
# Everything else is dropped and logged. Sandboxed processes have no network at all (gVisor
# --network=none); this boundary contains the worker host itself.

resource "aws_networkfirewall_rule_group" "egress_allowlist" {
  name     = "${local.prefix}-egress-allowlist"
  type     = "STATEFUL"
  capacity = 100

  rule_group {
    rules_source {
      rules_source_list {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["TLS_SNI", "HTTP_HOST"]
        targets              = var.egress_allowed_domains
      }
    }
    rule_variables {
      ip_sets {
        key = "HOME_NET"
        ip_set {
          definition = local.execution_cidrs
        }
      }
    }
  }
}

resource "aws_networkfirewall_firewall_policy" "egress" {
  name = "${local.prefix}-egress"

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]

    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }
    stateful_default_actions = ["aws:drop_established", "aws:alert_established"]

    stateful_rule_group_reference {
      priority     = 10
      resource_arn = aws_networkfirewall_rule_group.egress_allowlist.arn
    }
  }
}

resource "aws_networkfirewall_firewall" "egress" {
  name                = "${local.prefix}-egress"
  vpc_id              = aws_vpc.main.id
  firewall_policy_arn = aws_networkfirewall_firewall_policy.egress.arn
  delete_protection   = local.production

  dynamic "subnet_mapping" {
    for_each = aws_subnet.firewall
    content {
      subnet_id = subnet_mapping.value.id
    }
  }
}

resource "aws_networkfirewall_logging_configuration" "egress" {
  firewall_arn = aws_networkfirewall_firewall.egress.arn
  logging_configuration {
    log_destination_config {
      log_type             = "ALERT"
      log_destination_type = "CloudWatchLogs"
      log_destination      = { logGroup = aws_cloudwatch_log_group.firewall.name }
    }
  }
}

locals {
  # AZ -> firewall endpoint, for the execution subnets' default routes.
  firewall_endpoints = {
    for s in aws_networkfirewall_firewall.egress.firewall_status[0].sync_states :
    s.availability_zone => s.attachment[0].endpoint_id
  }
}
