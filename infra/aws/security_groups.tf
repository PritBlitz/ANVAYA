# Least-privilege paths between tiers. Nothing in the execution tier is reachable from outside,
# and only the API and worker can reach the data stores.

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "Public HTTPS entry point"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_security_group" "web" {
  name        = "${local.prefix}-web"
  description = "Next.js web tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "api" {
  name        = "${local.prefix}-api"
  description = "NestJS API tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "ai" {
  name        = "${local.prefix}-ai"
  description = "FastAPI AI service tasks (internal only)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "execution" {
  name        = "${local.prefix}-execution"
  description = "gVisor execution hosts running the worker"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "PostgreSQL"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "redis" {
  name        = "${local.prefix}-redis"
  description = "Redis"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "inference" {
  name        = "${local.prefix}-inference"
  description = "Private Ollama hosts"
  vpc_id      = aws_vpc.main.id
}

locals {
  # destination SG => list of [source SG, port]
  sg_paths = {
    web_from_alb       = { to = aws_security_group.web.id, from = aws_security_group.alb.id, port = 3000 }
    api_from_alb       = { to = aws_security_group.api.id, from = aws_security_group.alb.id, port = 3001 }
    api_from_web       = { to = aws_security_group.api.id, from = aws_security_group.web.id, port = 3001 }
    ai_from_api        = { to = aws_security_group.ai.id, from = aws_security_group.api.id, port = 8001 }
    ai_from_worker     = { to = aws_security_group.ai.id, from = aws_security_group.execution.id, port = 8001 }
    db_from_api        = { to = aws_security_group.db.id, from = aws_security_group.api.id, port = 5432 }
    db_from_worker     = { to = aws_security_group.db.id, from = aws_security_group.execution.id, port = 5432 }
    redis_from_api     = { to = aws_security_group.redis.id, from = aws_security_group.api.id, port = 6379 }
    redis_from_worker  = { to = aws_security_group.redis.id, from = aws_security_group.execution.id, port = 6379 }
    inference_from_ai  = { to = aws_security_group.inference.id, from = aws_security_group.ai.id, port = 11434 }
    worker_metrics_api = { to = aws_security_group.execution.id, from = aws_security_group.api.id, port = 9464 }
  }
  egress_all = {
    alb       = aws_security_group.alb.id
    web       = aws_security_group.web.id
    api       = aws_security_group.api.id
    ai        = aws_security_group.ai.id
    execution = aws_security_group.execution.id
    inference = aws_security_group.inference.id
  }
}

resource "aws_vpc_security_group_ingress_rule" "paths" {
  for_each                     = local.sg_paths
  security_group_id            = each.value.to
  referenced_security_group_id = each.value.from
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
  description                  = each.key
}

# Data stores need no egress; every other tier may initiate outbound connections (the execution
# tier's are then restricted to the firewall allowlist by routing).
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = local.egress_all
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
