data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# Pulls images, writes logs, and injects only the secrets each service needs.
resource "aws_iam_role" "ecs_execution" {
  name               = "${local.prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat(values(local.secret_arns), [aws_db_instance.postgres.master_user_secret[0].secret_arn])
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

data "aws_iam_policy_document" "storage_rw" {
  statement {
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [aws_efs_file_system.storage.arn]
    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.storage.arn]
    }
  }
}

# Runtime role of the API tasks: the shared artifact file system only.
resource "aws_iam_role" "api_task" {
  name               = "${local.prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api_storage" {
  name   = "storage"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.storage_rw.json
}

# Web and AI service tasks need no AWS API access at runtime.
resource "aws_iam_role" "no_access_task" {
  name               = "${local.prefix}-no-access-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# Execution hosts: SSM (no SSH keys), ECR read, secrets, storage, logs.
resource "aws_iam_role" "execution_host" {
  name               = "${local.prefix}-execution-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_ssm" {
  role       = aws_iam_role.execution_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "execution_ecr" {
  role       = aws_iam_role.execution_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "execution_logs" {
  role       = aws_iam_role.execution_host.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution_host.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role_policy" "execution_storage" {
  name   = "storage"
  role   = aws_iam_role.execution_host.id
  policy = data.aws_iam_policy_document.storage_rw.json
}

resource "aws_iam_instance_profile" "execution_host" {
  name = "${local.prefix}-execution-host"
  role = aws_iam_role.execution_host.name
}

resource "aws_iam_role" "inference_host" {
  name               = "${local.prefix}-inference-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "inference_ssm" {
  role       = aws_iam_role.inference_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "inference_host" {
  name = "${local.prefix}-inference-host"
  role = aws_iam_role.inference_host.name
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.prefix}-flow-logs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "vpc-flow-logs.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-logs"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}
