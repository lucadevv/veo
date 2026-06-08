# Module: secrets-manager · variables

variable "env" {
  type = string
}

variable "kms_key_arn" {
  description = "CMK ARN to encrypt the secrets (typically the pii key)"
  type        = string
}

variable "recovery_window_in_days" {
  type    = number
  default = 7
}

variable "generated_secrets" {
  description = <<-EOT
    Secrets whose value Terraform generates randomly (JWT keys, HMAC, panic keys).
    Stored under veo/<env>/<path>. If json_key is set, value is wrapped as JSON.
  EOT
  type = map(object({
    path             = string
    description      = optional(string, "")
    length           = optional(number, 64)
    special          = optional(bool, false)
    override_special = optional(string, "!#$%&*()-_=+")
    json_key         = optional(string, "")
  }))
  default = {}
}

variable "managed_secrets" {
  description = "Secrets created empty; value injected out-of-band (operator/CLI)."
  type = map(object({
    path        = string
    description = optional(string, "")
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
