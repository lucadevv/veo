# Module: cloudfront · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "name_suffix" {
  type    = string
  default = "media"
}

variable "origin_domain_name" {
  description = "S3 bucket regional domain name (origin)"
  type        = string
}

variable "aliases" {
  type    = list(string)
  default = []
}

variable "acm_certificate_arn" {
  description = "ACM cert (must be in us-east-1). Empty = default CF cert."
  type        = string
  default     = ""
}

variable "web_acl_arn" {
  description = "WAFv2 web ACL ARN (CLOUDFRONT scope)"
  type        = string
  default     = ""
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "default_root_object" {
  type    = string
  default = ""
}

variable "signed_urls_public_key_pem" {
  description = "PEM-encoded public key to enable signed URLs (private media)"
  type        = string
  default     = ""
}

variable "geo_restriction_type" {
  type    = string
  default = "none"
}

variable "geo_restriction_locations" {
  type    = list(string)
  default = []
}

variable "logging_bucket_domain" {
  description = "S3 bucket domain for CF access logs (bucket.s3.amazonaws.com)"
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
