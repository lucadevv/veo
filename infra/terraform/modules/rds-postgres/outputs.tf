# Module: rds-postgres · outputs

output "instance_id" {
  value = aws_db_instance.this.id
}

output "endpoint" {
  description = "Connection endpoint host:port"
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "DNS address (host only)"
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "secret_arn" {
  description = "Secrets Manager ARN holding master credentials"
  value       = aws_secretsmanager_secret.db.arn
}

output "secret_name" {
  value = aws_secretsmanager_secret.db.name
}

output "replica_endpoints" {
  value = aws_db_instance.replica[*].endpoint
}
