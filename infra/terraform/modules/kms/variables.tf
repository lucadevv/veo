# Module: kms · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "deletion_window_in_days" {
  description = "Pending deletion window for keys"
  type        = number
  default     = 30
}

variable "domains" {
  description = <<-EOT
    Map of data domains -> key config. One CMK is created per domain.
    Baseline domains required by VEO: pii, biometric, video, audit.
    `allowed_service_principals` grants AWS service principals (e.g.
    logs.amazonaws.com, s3.amazonaws.com) direct use of the key.
  EOT
  type = map(object({
    multi_region               = optional(bool, false)
    allowed_service_principals = optional(list(string), [])
  }))
  default = {
    pii       = { allowed_service_principals = ["rds.amazonaws.com", "secretsmanager.amazonaws.com"] }
    biometric = { allowed_service_principals = ["s3.amazonaws.com"] }
    video     = { allowed_service_principals = ["s3.amazonaws.com", "cloudfront.amazonaws.com"] }
    audit     = { allowed_service_principals = ["logs.amazonaws.com", "s3.amazonaws.com", "rds.amazonaws.com"] }
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
