# Module: s3-bucket · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "bucket_suffix" {
  description = "Suffix to build the bucket name veo-<env>-<suffix>"
  type        = string
}

variable "kms_key_arn" {
  description = "CMK ARN for SSE-KMS"
  type        = string
}

variable "versioning_enabled" {
  type    = bool
  default = true
}

variable "force_destroy" {
  type    = bool
  default = false
}

# Object Lock (WORM)
variable "object_lock_enabled" {
  type    = bool
  default = false
}

variable "object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE"
  type        = string
  default     = "GOVERNANCE"
}

variable "object_lock_days" {
  type    = number
  default = 365
}

variable "lifecycle_rules" {
  description = "Lifecycle rules"
  type = list(object({
    id                                 = string
    prefix                             = optional(string, "")
    expiration_days                    = optional(number)
    noncurrent_version_expiration_days = optional(number)
    transitions = optional(list(object({
      days          = number
      storage_class = string
    })), [])
  }))
  default = []
}

variable "cors_rules" {
  type = list(object({
    allowed_methods = list(string)
    allowed_origins = list(string)
    allowed_headers = optional(list(string), ["*"])
    expose_headers  = optional(list(string), [])
    max_age_seconds = optional(number, 3000)
  }))
  default = []
}

variable "logging_target_bucket" {
  type    = string
  default = ""
}

variable "cloudfront_distribution_arn" {
  description = "If set, allow read via this CloudFront distribution (OAC)"
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
