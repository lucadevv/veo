# Module: vpc · variables

variable "project" {
  description = "Project name (e.g. veo)"
  type        = string
  default     = "veo"
}

variable "env" {
  description = "Environment (dev|staging|prod)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs (3 required for multi-AZ baseline)"
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway (cheaper, dev only). Prod must be false."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "AWS services to expose via interface VPC endpoints (soberania)."
  type        = list(string)
  default = [
    "ecr.api",
    "ecr.dkr",
    "logs",
    "sts",
    "secretsmanager",
    "kms",
    "ec2",
    "elasticloadbalancing",
  ]
}

variable "enable_flow_logs" {
  description = "Enable VPC flow logs to CloudWatch"
  type        = bool
  default     = true
}

variable "flow_logs_retention_days" {
  description = "Retention for VPC flow logs"
  type        = number
  default     = 90
}

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default     = {}
}
