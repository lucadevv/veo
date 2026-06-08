# Module: rds-postgres · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "service" {
  description = "Logical service this DB belongs to (identity|payment|panic|audit|shared)"
  type        = string
}

# Networking
variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Database subnet IDs (must span >=2 AZ for multi-AZ)"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach Postgres (e.g. EKS node SG)"
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "Extra CIDRs allowed to reach Postgres"
  type        = list(string)
  default     = []
}

variable "port" {
  type    = number
  default = 5432
}

# Engine / sizing
variable "engine_version" {
  type    = string
  default = "16.4"
}

variable "parameter_group_family" {
  type    = string
  default = "postgres16"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "allocated_storage" {
  type    = number
  default = 50
}

variable "max_allocated_storage" {
  description = "Upper bound for storage autoscaling"
  type        = number
  default     = 200
}

variable "storage_type" {
  type    = string
  default = "gp3"
}

variable "iops" {
  type    = number
  default = 3000
}

variable "database_name" {
  type    = string
  default = "veo"
}

variable "master_username" {
  type    = string
  default = "veo_admin"
}

# HA / DR
variable "multi_az" {
  type    = bool
  default = true
}

variable "backup_retention_period" {
  type    = number
  default = 14
}

variable "backup_window" {
  type    = string
  default = "03:00-04:00"
}

variable "maintenance_window" {
  type    = string
  default = "sun:04:30-sun:05:30"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "apply_immediately" {
  type    = bool
  default = false
}

# Encryption / secrets
variable "kms_key_arn" {
  description = "CMK ARN for storage + performance insights encryption"
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN to encrypt the Secrets Manager secret (usually pii key)"
  type        = string
  default     = null
}

variable "secret_recovery_window_days" {
  type    = number
  default = 7
}

# Observability
variable "performance_insights_enabled" {
  type    = bool
  default = true
}

variable "performance_insights_retention" {
  type    = number
  default = 7
}

variable "monitoring_interval" {
  description = "Enhanced monitoring interval in seconds (0 = disabled)"
  type        = number
  default     = 60
}

# Read replicas
variable "read_replica_count" {
  type    = number
  default = 0
}

variable "replica_instance_class" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
