# Module: iam-roles · outputs

output "role_arns" {
  description = "Map of service account name -> IAM role ARN (annotate the SA with this)"
  value       = { for sa, r in aws_iam_role.this : sa => r.arn }
}

output "role_names" {
  value = { for sa, r in aws_iam_role.this : sa => r.name }
}

# Annotation a poner en cada ServiceAccount de K8s:
#   eks.amazonaws.com/role-arn: <role_arns[sa]>
output "service_account_annotations" {
  description = "Ready-to-use IRSA annotations per service account"
  value = {
    for sa, r in aws_iam_role.this : sa => {
      "eks.amazonaws.com/role-arn" = r.arn
    }
  }
}
