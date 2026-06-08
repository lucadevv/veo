# Module: cloudfront · outputs

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.this.arn
}

output "domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "hosted_zone_id" {
  value = aws_cloudfront_distribution.this.hosted_zone_id
}

output "key_group_id" {
  value = var.signed_urls_public_key_pem != "" ? aws_cloudfront_key_group.this[0].id : null
}
