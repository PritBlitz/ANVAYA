locals {
  images = {
    web = "${aws_ecr_repository.repo["web"].repository_url}:${var.image_tag}"
    api = "${aws_ecr_repository.repo["api"].repository_url}:${var.image_tag}"
    ai  = "${aws_ecr_repository.repo["ai-service"].repository_url}:${var.image_tag}"
  }
  internal_domain = "${var.environment}.${var.name}.internal"
  api_internal    = "http://api.${local.internal_domain}:3001"
  ai_internal     = "http://ai.${local.internal_domain}:8001"
  public_url      = "https://${var.public_hostname}"

  # Shared by the API service and the execution hosts' worker (same image, same config contract).
  control_plane_env = {
    NODE_ENV                = "production"
    PORT                    = "3001"
    LOG_LEVEL               = "info"
    PUBLIC_API_URL          = local.public_url
    WEB_APP_URL             = local.public_url
    WEB_ORIGINS             = local.public_url
    TRUST_PROXY             = "true"
    COOKIE_SECURE           = "true"
    AUTH_DEV_LOGIN_ENABLED  = "false"
    DATABASE_URL            = local.database_url
    NODE_EXTRA_CA_CERTS     = "/app/certs/rds-global-bundle.pem"
    AI_SERVICE_URL          = local.ai_internal
    REPOSITORY_SOURCE       = "github"
    STORAGE_DIR             = "/mnt/storage"
    # No collector is deployed by this module; point OTLP at one (e.g. ADOT) to enable traces.
    OTEL_TRACES_EXPORTER    = "none"
    EXECUTION_DRIVER        = "gvisor"
    SANDBOX_DEPENDENCY_FETCH = "disabled"
  }
  control_plane_secrets = {
    PGPASSWORD                 = local.db_password_ref
    REDIS_URL                  = local.secret_arns["redis-url"]
    AI_SERVICE_TOKEN           = local.secret_arns["ai-service-token"]
    METRICS_TOKEN              = local.secret_arns["metrics-token"]
    GITHUB_APP_ID              = local.secret_arns["github-app-id"]
    GITHUB_APP_PRIVATE_KEY     = local.secret_arns["github-app-private-key"]
    GITHUB_WEBHOOK_SECRET      = local.secret_arns["github-webhook-secret"]
    GITHUB_OAUTH_CLIENT_ID     = local.secret_arns["github-oauth-client-id"]
    GITHUB_OAUTH_CLIENT_SECRET = local.secret_arns["github-oauth-client-secret"]
  }
}

resource "aws_ecr_repository" "repo" {
  for_each             = toset(["web", "api", "ai-service"])
  name                 = "${local.prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !local.production
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images (rollback window)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = local.internal_domain
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "svc" {
  for_each = toset(["api", "ai"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

# --- Task definitions -------------------------------------------------------------------------

locals {
  task_defs = {
    web = {
      cpu = 512, memory = 1024, port = 3000, image = local.images.web, role = aws_iam_role.no_access_task.arn
      command = null
      env = {
        NODE_ENV          = "production"
        PORT              = "3000"
        ANVAYA_API_ORIGIN = local.api_internal
      }
      secrets = {}
      health  = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1"]
    }
    api = {
      cpu = 1024, memory = 2048, port = 3001, image = local.images.api, role = aws_iam_role.api_task.arn
      # Migrations are checksum-protected and idempotent; every task applies pending ones first.
      command = ["sh", "-c", "node dist/database/migrate.cli.js && node dist/main.js"]
      env     = local.control_plane_env
      secrets = local.control_plane_secrets
      health  = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3001/api/v1/health/live >/dev/null || exit 1"]
    }
    ai = {
      cpu = 1024, memory = 2048, port = 8001, image = local.images.ai, role = aws_iam_role.no_access_task.arn
      command = null
      env = {
        NODE_ENV           = "production"
        OLLAMA_BASE_URL    = var.enable_local_inference ? "http://${aws_lb.inference[0].dns_name}:11434" : ""
        EMBEDDING_PROVIDER = "ollama"
        HOSTED_PROVIDER    = "none"
      }
      secrets = { AI_SERVICE_TOKEN = local.secret_arns["ai-service-token"] }
      health  = ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health/live', timeout=3)\""]
    }
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.task_defs
  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = each.value.role
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  dynamic "volume" {
    for_each = each.key == "api" ? [1] : []
    content {
      name = "storage"
      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.storage.id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.storage.id
          iam             = "ENABLED"
        }
      }
    }
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = each.value.image
    essential              = true
    command                = each.value.command
    readonlyRootFilesystem = false
    portMappings           = [{ containerPort = each.value.port, protocol = "tcp" }]
    mountPoints            = each.key == "api" ? [{ sourceVolume = "storage", containerPath = "/mnt/storage", readOnly = false }] : []
    environment            = [for k, v in each.value.env : { name = k, value = v }]
    secrets                = [for k, v in each.value.secrets : { name = k, valueFrom = v }]
    healthCheck            = { command = each.value.health, interval = 30, timeout = 5, retries = 3, startPeriod = 60 }
    linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

# --- Public load balancer -----------------------------------------------------------------------

resource "aws_lb" "public" {
  name                       = local.prefix
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = local.production
  idle_timeout               = 900 # SSE run streams and long local-model calls
}

resource "aws_lb_target_group" "web" {
  name        = "${local.prefix}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/login"
    matcher = "200"
  }
  deregistration_delay = 30
}

resource "aws_lb_target_group" "api" {
  name        = "${local.prefix}-api"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/api/v1/health/ready"
    matcher = "200"
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Browsers call the same-origin /api/v1 (cookies stay first-party); webhooks land on the API too.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern {
      values = ["/api/v1/*"]
    }
  }
}

# The metrics endpoint is for the internal scraper only, never the internet.
resource "aws_lb_listener_rule" "deny_internal" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 5
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
  condition {
    path_pattern {
      values = ["/api/v1/internal/*"]
    }
  }
}

# --- Services -----------------------------------------------------------------------------------

locals {
  services = {
    web = { sg = aws_security_group.web.id, tg = aws_lb_target_group.web.arn, discovery = null }
    api = { sg = aws_security_group.api.id, tg = aws_lb_target_group.api.arn, discovery = aws_service_discovery_service.svc["api"].arn }
    ai  = { sg = aws_security_group.ai.id, tg = null, discovery = aws_service_discovery_service.svc["ai"].arn }
  }
}

resource "aws_ecs_service" "svc" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.svc[each.key].arn
  desired_count          = var.service_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [each.value.sg]
    assign_public_ip = false
  }

  # Rolling deploys with automatic rollback (Phase 8: rollback tested): a new task definition that
  # fails health checks is rolled back to the last steady revision by ECS.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  dynamic "load_balancer" {
    for_each = each.value.tg == null ? [] : [each.value.tg]
    content {
      target_group_arn = load_balancer.value
      container_name   = each.key
      container_port   = local.task_defs[each.key].port
    }
  }

  dynamic "service_registries" {
    for_each = each.value.discovery == null ? [] : [each.value.discovery]
    content {
      registry_arn = service_registries.value
    }
  }

  depends_on = [aws_lb_listener.https]
}
