# Outputs del entorno prod

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnet_ids
}

output "database_subnet_ids" {
  value = module.vpc.database_subnet_ids
}

# EKS
output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "eks_oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}"
}

# KMS
output "kms_key_arns" {
  value = module.kms.key_arns
}

# RDS (criticas + compartida)
output "rds_endpoints" {
  description = "Endpoint per critical service DB"
  value       = { for svc, db in module.rds : svc => db.endpoint }
}

output "rds_secret_arns" {
  description = "Secrets Manager ARNs holding DB credentials"
  value       = merge({ for svc, db in module.rds : svc => db.secret_arn }, { shared = module.rds_shared.secret_arn })
}

output "rds_shared_endpoint" {
  value = module.rds_shared.endpoint
}

# Redis
output "redis_primary_endpoint" {
  value = module.redis.primary_endpoint_address
}

output "redis_auth_secret_arn" {
  value = module.redis.auth_secret_arn
}

# MSK
output "msk_bootstrap_brokers_sasl_iam" {
  value = module.msk.bootstrap_brokers_sasl_iam
}

# S3
output "s3_media_bucket" {
  value = module.s3_media.bucket_name
}

output "s3_audit_bucket" {
  value = module.s3_audit.bucket_name
}

output "s3_backups_bucket" {
  value = module.s3_backups.bucket_name
}

# CloudFront
output "cloudfront_media_domain" {
  value = module.cloudfront_media.domain_name
}

# IRSA
output "irsa_role_arns" {
  description = "Map of service account -> IAM role ARN (annotate K8s SAs)"
  value       = module.iam_irsa.role_arns
}

# App secrets
output "app_secret_arns" {
  value = module.app_secrets.generated_secret_arns
}
