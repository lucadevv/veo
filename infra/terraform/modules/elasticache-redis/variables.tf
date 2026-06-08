# Module: elasticache-redis · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "name_suffix" {
  description = "Logical suffix for secret naming (e.g. shared, sessions)"
  type        = string
  default     = "shared"
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Database subnet IDs (>=2 AZ for Multi-AZ)"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  type    = list(string)
  default = []
}

variable "port" {
  type    = number
  default = 6379
}

variable "engine_version" {
  type    = string
  default = "7.1"
}

variable "parameter_group_family" {
  type    = string
  default = "redis7"
}

variable "node_type" {
  type    = string
  default = "cache.t4g.medium"
}

# HA topology
variable "multi_az_enabled" {
  type    = bool
  default = true
}

variable "automatic_failover_enabled" {
  type    = bool
  default = true
}

variable "cluster_mode_enabled" {
  type    = bool
  default = false
}

variable "num_cache_clusters" {
  description = "Nodes when cluster-mode disabled (1 primary + N replicas). >=2 for failover."
  type        = number
  default     = 2
}

variable "num_node_groups" {
  description = "Shards when cluster-mode enabled"
  type        = number
  default     = 2
}

variable "replicas_per_node_group" {
  description = "Replicas per shard when cluster-mode enabled"
  type        = number
  default     = 1
}

# Encryption
variable "kms_key_arn" {
  type = string
}

variable "transit_encryption_enabled" {
  type    = bool
  default = true
}

variable "secrets_kms_key_arn" {
  type    = string
  default = null
}

variable "secret_recovery_window_days" {
  type    = number
  default = 7
}

# Backups
variable "snapshot_retention_limit" {
  type    = number
  default = 7
}

variable "snapshot_window" {
  type    = string
  default = "02:00-03:00"
}

variable "maintenance_window" {
  type    = string
  default = "sun:03:00-sun:04:00"
}

variable "apply_immediately" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
