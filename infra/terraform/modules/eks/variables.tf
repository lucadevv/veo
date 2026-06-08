# Module: eks · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "cluster_version" {
  type    = string
  default = "1.31"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  description = "Private subnets for nodes (must span 3 AZ)"
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnets for public-facing load balancers"
  type        = list(string)
  default     = []
}

variable "endpoint_public_access" {
  description = "Expose the API server publicly (restrict via public_access_cidrs)"
  type        = bool
  default     = true
}

variable "public_access_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN to encrypt Kubernetes secrets in etcd"
  type        = string
  default     = null
}

variable "enabled_cluster_log_types" {
  type    = list(string)
  default = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}

variable "node_groups" {
  description = "Managed node groups"
  type = map(object({
    instance_types = list(string)
    capacity_type  = optional(string, "ON_DEMAND")
    ami_type       = optional(string, "AL2023_x86_64_STANDARD")
    disk_size      = optional(number, 50)
    desired_size   = number
    min_size       = number
    max_size       = number
    labels         = optional(map(string), {})
    taints = optional(list(object({
      key    = string
      value  = string
      effect = string
    })), [])
  }))
}

variable "cluster_addons" {
  description = "EKS managed addons"
  type = map(object({
    version                  = optional(string, "")
    service_account_role_arn = optional(string, "")
  }))
  default = {
    vpc-cni              = {}
    coredns              = {}
    kube-proxy           = {}
    "aws-ebs-csi-driver" = {}
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
