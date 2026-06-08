# Module: kms
# Customer Master Keys (CMK) por dominio de datos. Rotacion anual obligatoria.
# Una key por dominio: pii, biometric, video, audit (+ los que se pasen).
# Cada key tiene su alias `alias/veo-<env>-<domain>`.

locals {
  name = "${var.project}-${var.env}"
}

data "aws_caller_identity" "current" {}

# Base key policy: cuenta tiene admin total; servicios se autorizan via grants/IAM.
locals {
  root_statement = [
    {
      Sid       = "EnableRootAccountAdmin"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    },
  ]
}

resource "aws_kms_key" "this" {
  for_each = var.domains

  description             = "VEO ${var.env} CMK - domain ${each.key}"
  deletion_window_in_days = var.deletion_window_in_days
  enable_key_rotation     = true # rotacion anual obligatoria (AWS default 365d)
  multi_region            = each.value.multi_region

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      local.root_statement,
      length(each.value.allowed_service_principals) > 0 ? [
        {
          Sid       = "AllowServiceUse"
          Effect    = "Allow"
          Principal = { Service = each.value.allowed_service_principals }
          Action = [
            "kms:Encrypt",
            "kms:Decrypt",
            "kms:ReEncrypt*",
            "kms:GenerateDataKey*",
            "kms:DescribeKey",
            "kms:CreateGrant",
          ]
          Resource = "*"
        }
      ] : [],
    )
  })

  tags = merge(var.tags, {
    Name   = "${local.name}-kms-${each.key}"
    Domain = each.key
  })
}

resource "aws_kms_alias" "this" {
  for_each = var.domains

  name          = "alias/${local.name}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
