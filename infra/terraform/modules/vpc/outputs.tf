# Module: vpc · outputs

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC CIDR block"
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (EKS nodes/pods)"
  value       = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  description = "Database subnet IDs (RDS/Redis/MSK)"
  value       = aws_subnet.database[*].id
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs"
  value       = aws_nat_gateway.this[*].id
}

output "availability_zones" {
  description = "AZs in use"
  value       = var.availability_zones
}

output "vpce_security_group_id" {
  description = "Security group used by interface VPC endpoints"
  value       = aws_security_group.vpce.id
}
