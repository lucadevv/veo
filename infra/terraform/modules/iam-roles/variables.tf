# Module: iam-roles · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "namespace" {
  description = "Kubernetes namespace where the service accounts live (veo-<env>)"
  type        = string
}

variable "oidc_provider_arn" {
  description = "EKS OIDC provider ARN"
  type        = string
}

variable "oidc_provider_url" {
  description = "EKS OIDC issuer URL"
  type        = string
}

variable "service_accounts" {
  description = <<-EOT
    Map of K8s service account name -> IAM config. One IRSA role is created per
    entry, trust-scoped to system:serviceaccount:<namespace>:<sa>.
    - statements: inline least-privilege policy statements
    - managed_policy_arns: extra managed policies to attach
  EOT
  type = map(object({
    statements = optional(list(object({
      sid       = optional(string)
      effect    = optional(string, "Allow")
      actions   = list(string)
      resources = list(string)
    })), [])
    managed_policy_arns = optional(list(string), [])
  }))
}

variable "tags" {
  type    = map(string)
  default = {}
}
