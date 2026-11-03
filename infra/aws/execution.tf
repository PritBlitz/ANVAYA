# gVisor execution hosts (ADR-0002). Each runs the worker (orchestration + verification) as an
# unprivileged systemd service whose only privilege is `sudo -n /usr/bin/runsc`. The worker image's
# /app is pure JS/WASM (npm ci --ignore-scripts), so it is copied out of the API image and run with
# the host's Node 22. Docker on the host is used only by root at boot, to extract /app and to
# provision sandbox root filesystems; the worker user has no access to it.

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  # Must match PYTHON_IMAGE / NODE_IMAGE in apps/api/src/execution/profiles.ts (digest-pinned).
  sandbox_images = [
    "python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8",
    "node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914",
  ]
}

resource "aws_launch_template" "execution" {
  name_prefix   = "${local.prefix}-execution-"
  image_id      = data.aws_ssm_parameter.ubuntu.value
  instance_type = var.execution_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.execution_host.arn
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.execution.id]
  }

  # IMDSv2 only, one hop: nothing but the host itself can reach instance metadata.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 100
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = aws_kms_key.data.arn
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/execution-host.sh.tftpl", {
    region          = var.region
    api_image       = local.images.api
    ecr_registry    = split("/", aws_ecr_repository.repo["api"].repository_url)[0]
    sandbox_images  = join(" ", local.sandbox_images)
    efs_id          = aws_efs_file_system.storage.id
    efs_access      = aws_efs_access_point.storage.id
    env             = merge(local.control_plane_env, { METRICS_PORT = "9464" })
    secrets         = local.control_plane_secrets
    log_group       = aws_cloudwatch_log_group.svc["worker"].name
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.prefix}-execution", Role = "execution" }
  }
}

resource "aws_autoscaling_group" "execution" {
  name                = "${local.prefix}-execution"
  min_size            = var.execution_host_count
  max_size            = var.execution_host_count * 2
  desired_capacity    = var.execution_host_count
  vpc_zone_identifier = aws_subnet.execution[*].id
  health_check_type   = "EC2"

  launch_template {
    id      = aws_launch_template.execution.id
    version = aws_launch_template.execution.latest_version
  }

  # A new image tag produces a new launch template version; hosts are replaced gradually and an
  # instance refresh that fails health checks rolls back to the previous version.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      auto_rollback          = true
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.prefix}-execution"
    propagate_at_launch = true
  }

  depends_on = [aws_networkfirewall_firewall.egress, aws_efs_mount_target.storage]
}
