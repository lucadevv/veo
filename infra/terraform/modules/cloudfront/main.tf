# Module: cloudfront
# CDN para servir media/video desde S3 via Origin Access Control (OAC),
# con WAF opcional y soporte de signed URLs (trusted key group). HTTPS-only.
#
# Nota: WAFv2 con scope CLOUDFRONT debe crearse en us-east-1. Este modulo asume
# que se instancia con un provider en us-east-1.

locals {
  name = "${var.project}-${var.env}-${var.name_suffix}"
}

resource "aws_cloudfront_origin_access_control" "this" {
  name                              = "${local.name}-oac"
  description                       = "OAC for ${local.name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Public key + key group para signed URLs (acceso a media privada con caducidad).
resource "aws_cloudfront_public_key" "this" {
  count       = var.signed_urls_public_key_pem != "" ? 1 : 0
  name        = "${local.name}-pubkey"
  comment     = "Signed URL public key for ${local.name}"
  encoded_key = var.signed_urls_public_key_pem
}

resource "aws_cloudfront_key_group" "this" {
  count   = var.signed_urls_public_key_pem != "" ? 1 : 0
  name    = "${local.name}-keygroup"
  comment = "Trusted key group for ${local.name}"
  items   = [aws_cloudfront_public_key.this[0].id]
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "VEO ${var.env} CDN - ${var.name_suffix}"
  price_class         = var.price_class
  default_root_object = var.default_root_object
  aliases             = var.aliases
  web_acl_id          = var.web_acl_arn != "" ? var.web_acl_arn : null

  origin {
    domain_name              = var.origin_domain_name
    origin_id                = "s3-${local.name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${local.name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed policy CachingOptimized.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    trusted_key_groups = var.signed_urls_public_key_pem != "" ? [aws_cloudfront_key_group.this[0].id] : []
  }

  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_locations
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != "" ? "TLSv1.2_2021" : "TLSv1"
  }

  dynamic "logging_config" {
    for_each = var.logging_bucket_domain != "" ? [1] : []
    content {
      bucket          = var.logging_bucket_domain
      prefix          = "${local.name}/"
      include_cookies = false
    }
  }

  tags = merge(var.tags, { Name = local.name })
}
