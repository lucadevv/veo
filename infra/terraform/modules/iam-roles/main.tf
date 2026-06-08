# Module: iam-roles
# IRSA (IAM Roles for Service Accounts) — un rol IAM por service account de K8s,
# con trust policy ligada al OIDC provider del cluster y restringida a
# system:serviceaccount:<namespace>:<sa>. Permisos minimos por servicio.

locals {
  name      = "${var.project}-${var.env}"
  namespace = var.namespace

  # OIDC issuer URL sin el prefijo https:// (para construir las condiciones).
  oidc_url = replace(var.oidc_provider_url, "https://", "")
}

data "aws_caller_identity" "current" {}

# Trust policy por servicio: solo el SA exacto puede asumir el rol.
data "aws_iam_policy_document" "assume" {
  for_each = var.service_accounts

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_url}:sub"
      values   = ["system:serviceaccount:${local.namespace}:${each.key}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  for_each = var.service_accounts

  name                 = "${local.name}-irsa-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.assume[each.key].json
  max_session_duration = 3600

  tags = merge(var.tags, {
    Name           = "${local.name}-irsa-${each.key}"
    ServiceAccount = each.key
  })
}

# Politica inline por servicio, construida a partir de los statements provistos.
# Si un servicio no tiene statements, no se crea politica (rol sin permisos AWS).
locals {
  sa_with_statements = {
    for sa, cfg in var.service_accounts : sa => cfg
    if length(cfg.statements) > 0
  }
}

data "aws_iam_policy_document" "inline" {
  for_each = local.sa_with_statements

  dynamic "statement" {
    for_each = each.value.statements
    content {
      sid       = lookup(statement.value, "sid", null)
      effect    = lookup(statement.value, "effect", "Allow")
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_policy" "this" {
  for_each = local.sa_with_statements

  name   = "${local.name}-irsa-${each.key}"
  policy = data.aws_iam_policy_document.inline[each.key].json

  tags = merge(var.tags, { ServiceAccount = each.key })
}

resource "aws_iam_role_policy_attachment" "this" {
  for_each = local.sa_with_statements

  role       = aws_iam_role.this[each.key].name
  policy_arn = aws_iam_policy.this[each.key].arn
}

# Adjuntar policies AWS-managed o externas adicionales por servicio.
resource "aws_iam_role_policy_attachment" "managed" {
  for_each = {
    for pair in flatten([
      for sa, cfg in var.service_accounts : [
        for arn in cfg.managed_policy_arns : {
          key = "${sa}:${arn}"
          sa  = sa
          arn = arn
        }
      ]
    ]) : pair.key => pair
  }

  role       = aws_iam_role.this[each.value.sa].name
  policy_arn = each.value.arn
}
