# Module: elasticache-redis · outputs

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}

output "primary_endpoint_address" {
  description = "Primary endpoint (cluster-mode disabled)"
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint_address" {
  value = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "configuration_endpoint_address" {
  description = "Configuration endpoint (cluster-mode enabled)"
  value       = aws_elasticache_replication_group.this.configuration_endpoint_address
}

output "port" {
  value = var.port
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "auth_secret_arn" {
  description = "Secrets Manager ARN for the AUTH token (null if TLS disabled)"
  value       = var.transit_encryption_enabled ? aws_secretsmanager_secret.auth[0].arn : null
}
