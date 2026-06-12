# Module: secrets-manager · outputs

output "generated_secret_arns" {
  description = "Map of logical name -> Secrets Manager ARN (generated)"
  value       = { for k, v in aws_secretsmanager_secret.generated : k => v.arn }
}

output "managed_secret_arns" {
  description = "Map of logical name -> Secrets Manager ARN (managed/placeholder)"
  value       = { for k, v in aws_secretsmanager_secret.managed : k => v.arn }
}

output "keypair_secret_arns" {
  description = "Map of logical name -> Secrets Manager ARN (keypair)"
  value       = { for k, v in aws_secretsmanager_secret.keypair : k => v.arn }
}

output "all_secret_arns" {
  description = "All secret ARNs (for IRSA policy resource scoping)"
  value = concat(
    [for v in aws_secretsmanager_secret.generated : v.arn],
    [for v in aws_secretsmanager_secret.keypair : v.arn],
    [for v in aws_secretsmanager_secret.managed : v.arn],
  )
}
