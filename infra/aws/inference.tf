# Private Ollama hosts: local inference stays the default (CLAUDE.md §11) — no paid provider is
# used unless a workspace opts in. Reachable only from the AI service through an internal NLB.

resource "aws_launch_template" "inference" {
  count         = var.enable_local_inference ? 1 : 0
  name_prefix   = "${local.prefix}-inference-"
  image_id      = data.aws_ssm_parameter.ubuntu.value
  instance_type = var.inference_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.inference_host.arn
  }
  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.inference.id]
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size = 80
      volume_type = "gp3"
      encrypted   = true
      kms_key_id  = aws_kms_key.data.arn
    }
  }
  user_data = base64encode(<<-EOT
    #!/bin/bash
    set -euo pipefail
    # Ollama's official installer, then the two models the AI service is configured for.
    curl -fsSL https://ollama.com/install.sh | sh
    mkdir -p /etc/systemd/system/ollama.service.d
    printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\nEnvironment="OLLAMA_MAX_LOADED_MODELS=2"\nEnvironment="OLLAMA_NUM_PARALLEL=1"\n' > /etc/systemd/system/ollama.service.d/override.conf
    systemctl daemon-reload && systemctl restart ollama
    sleep 5
    ollama pull qwen2.5-coder:7b
    ollama pull nomic-embed-text
  EOT
  )
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.prefix}-inference", Role = "inference" }
  }
}

resource "aws_lb" "inference" {
  count              = var.enable_local_inference ? 1 : 0
  name               = "${local.prefix}-inference"
  load_balancer_type = "network"
  internal           = true
  subnets            = aws_subnet.app[*].id
  security_groups    = [aws_security_group.inference_nlb[0].id]
}

resource "aws_security_group" "inference_nlb" {
  count       = var.enable_local_inference ? 1 : 0
  name        = "${local.prefix}-inference-nlb"
  description = "Internal NLB in front of Ollama"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "inference_nlb_from_ai" {
  count                        = var.enable_local_inference ? 1 : 0
  security_group_id            = aws_security_group.inference_nlb[0].id
  referenced_security_group_id = aws_security_group.ai.id
  from_port                    = 11434
  to_port                      = 11434
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "inference_nlb_to_hosts" {
  count                        = var.enable_local_inference ? 1 : 0
  security_group_id            = aws_security_group.inference_nlb[0].id
  referenced_security_group_id = aws_security_group.inference.id
  from_port                    = 11434
  to_port                      = 11434
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "inference_from_nlb" {
  count                        = var.enable_local_inference ? 1 : 0
  security_group_id            = aws_security_group.inference.id
  referenced_security_group_id = aws_security_group.inference_nlb[0].id
  from_port                    = 11434
  to_port                      = 11434
  ip_protocol                  = "tcp"
}

resource "aws_lb_target_group" "inference" {
  count       = var.enable_local_inference ? 1 : 0
  name        = "${local.prefix}-ollama"
  port        = 11434
  protocol    = "TCP"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id
  health_check {
    protocol = "HTTP"
    path     = "/api/version"
  }
}

resource "aws_lb_listener" "inference" {
  count             = var.enable_local_inference ? 1 : 0
  load_balancer_arn = aws_lb.inference[0].arn
  port              = 11434
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.inference[0].arn
  }
}

resource "aws_autoscaling_group" "inference" {
  count               = var.enable_local_inference ? 1 : 0
  name                = "${local.prefix}-inference"
  min_size            = 1
  max_size            = 2
  desired_capacity    = 1
  vpc_zone_identifier = aws_subnet.app[*].id
  target_group_arns   = [aws_lb_target_group.inference[0].arn]
  health_check_type   = "ELB"
  launch_template {
    id      = aws_launch_template.inference[0].id
    version = aws_launch_template.inference[0].latest_version
  }
  tag {
    key                 = "Name"
    value               = "${local.prefix}-inference"
    propagate_at_launch = true
  }
}
