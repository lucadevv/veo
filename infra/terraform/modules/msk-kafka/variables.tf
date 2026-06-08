# Module: msk-kafka · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Subnets for brokers — one per AZ (length must divide broker count)"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  type    = list(string)
  default = []
}

variable "kafka_version" {
  type    = string
  default = "3.6.0"
}

variable "number_of_broker_nodes" {
  description = "Total brokers (multiple of #AZ; 3 brokers for 3 AZ)"
  type        = number
  default     = 3
}

variable "broker_instance_type" {
  type    = string
  default = "kafka.m7g.large"
}

variable "broker_volume_size" {
  description = "EBS volume size per broker (GiB)"
  type        = number
  default     = 100
}

variable "kms_key_arn" {
  description = "CMK ARN for at-rest encryption"
  type        = string
}

variable "enhanced_monitoring" {
  type    = string
  default = "PER_TOPIC_PER_BROKER"
}

# Server properties
variable "auto_create_topics" {
  type    = bool
  default = false
}

variable "default_replication_factor" {
  type    = number
  default = 3
}

variable "min_insync_replicas" {
  type    = number
  default = 2
}

variable "num_partitions" {
  type    = number
  default = 6
}

variable "log_retention_hours" {
  type    = number
  default = 168
}

variable "log_retention_days" {
  description = "CloudWatch retention for broker logs"
  type        = number
  default     = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
