resource "aws_kms_key" "data" {
  description             = "${local.prefix} data at rest (RDS, Redis, S3, secrets, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

# --- PostgreSQL + pgvector (RDS supports the vector extension on PostgreSQL 15.2+) ---

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.app[*].id
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.prefix}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "postgres" {
  identifier                      = local.prefix
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage_gb
  max_allocated_storage           = var.db_allocated_storage_gb * 4
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "anvaya"
  username                        = "anvaya"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.data.arn
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.postgres.name
  multi_az                        = local.production
  publicly_accessible             = false
  backup_retention_period         = local.production ? 30 : 7
  backup_window                   = "19:00-20:00"
  maintenance_window              = "sun:20:30-sun:21:30"
  copy_tags_to_snapshot           = true
  deletion_protection             = local.production
  skip_final_snapshot             = !local.production
  final_snapshot_identifier       = local.production ? "${local.prefix}-final" : null
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports = ["postgresql"]
  auto_minor_version_upgrade      = true
}

# --- Redis (BullMQ queues, rate limits, SSE fan-out) ---

resource "aws_elasticache_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.app[*].id
}

# Redis AUTH over TLS. The token is generated here and kept in Secrets Manager; it is also in
# Terraform state, which is why state lives in an encrypted, access-controlled S3 bucket.
resource "random_password" "redis_auth" {
  length           = 48
  special          = true
  override_special = "!&#$^<>-"
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name       = "${local.prefix}/redis-auth-token"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis_auth.result
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = local.prefix
  description                = "${local.prefix} queues and rate limits"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = local.production ? 2 : 1
  automatic_failover_enabled = local.production
  multi_az_enabled           = local.production
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  snapshot_retention_limit   = local.production ? 7 : 1
}

# --- Shared storage: snapshots, run artifacts, logs -------------------------------------------
# The API and worker keep artifacts under STORAGE_DIR on a filesystem (no object-store driver yet),
# so every API task and execution host mounts the same encrypted EFS file system there.

resource "aws_efs_file_system" "storage" {
  creation_token   = "${local.prefix}-storage"
  encrypted        = true
  kms_key_id       = aws_kms_key.data.arn
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
  tags = { Name = "${local.prefix}-storage" }
}

resource "aws_efs_backup_policy" "storage" {
  file_system_id = aws_efs_file_system.storage.id
  backup_policy {
    status = "ENABLED"
  }
}

resource "aws_security_group" "efs" {
  name        = "${local.prefix}-efs"
  description = "Shared artifact storage (NFS)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "efs" {
  for_each = {
    api       = aws_security_group.api.id
    execution = aws_security_group.execution.id
  }
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = each.value
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}

resource "aws_efs_mount_target" "storage" {
  count           = 2
  file_system_id  = aws_efs_file_system.storage.id
  subnet_id       = aws_subnet.app[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# Everything is written as the image's unprivileged user; TLS and IAM auth are enforced.
resource "aws_efs_access_point" "storage" {
  file_system_id = aws_efs_file_system.storage.id
  posix_user {
    uid = var.storage_uid
    gid = var.storage_gid
  }
  root_directory {
    path = "/anvaya"
    creation_info {
      owner_uid   = var.storage_uid
      owner_gid   = var.storage_gid
      permissions = "0750"
    }
  }
}

resource "aws_efs_file_system_policy" "storage" {
  file_system_id = aws_efs_file_system.storage.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = { AWS = "*" }
      Action    = "*"
      Resource  = aws_efs_file_system.storage.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
