variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "anvaya"
}

variable "environment" {
  description = "Deployment environment. Production enables Multi-AZ data stores, deletion protection and per-AZ NAT."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-south-1"
}

variable "vpc_cidr" {
  description = "CIDR of the VPC. Split into public, application, execution and firewall subnets across two AZs."
  type        = string
  default     = "10.40.0.0/16"
}

variable "certificate_arn" {
  description = "ACM certificate for the public HTTPS listener."
  type        = string
}

variable "public_hostname" {
  description = "Public hostname users reach (PUBLIC_API_URL / WEB_APP_URL)."
  type        = string
}

variable "image_tag" {
  description = "Immutable image tag (git SHA) deployed for web, api and ai-service. Roll back by redeploying the previous tag."
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class for PostgreSQL (pgvector)."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage; autoscaling may grow it to 4x."
  type        = number
  default     = 50
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "service_desired_count" {
  description = "Tasks per ECS service (web, api, ai-service)."
  type        = number
  default     = 2
}

variable "execution_instance_type" {
  description = "Instance type of the gVisor execution hosts that run the worker."
  type        = string
  default     = "c7i.large"
}

variable "execution_host_count" {
  description = "Number of execution hosts."
  type        = number
  default     = 2
}

variable "enable_local_inference" {
  description = "Run private Ollama hosts for local inference (the product default). Disable only if every workspace uses an approved hosted provider."
  type        = bool
  default     = true
}

variable "inference_instance_type" {
  description = "Instance type for Ollama hosts (CPU by default; choose a GPU family for production throughput)."
  type        = string
  default     = "r7i.xlarge"
}

variable "egress_allowed_domains" {
  description = "The only domains the execution subnets may reach (TLS SNI / HTTP Host). Leading dot matches subdomains."
  type        = list(string)
  default = [
    ".github.com",
    ".githubusercontent.com",
    "api.github.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
  ]
}

variable "alarm_email" {
  description = "Optional e-mail subscribed to operational alarms."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "storage_uid" {
  description = "uid of the `anvaya` user in the API image, which owns shared storage (check: docker run --rm --entrypoint id <api image>)."
  type        = number
  default     = 100
}

variable "storage_gid" {
  description = "gid of the `anvaya` group in the API image."
  type        = number
  default     = 101
}
