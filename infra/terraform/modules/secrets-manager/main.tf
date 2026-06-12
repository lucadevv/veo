# Module: secrets-manager
# Secretos de aplicacion en AWS Secrets Manager, cifrados con CMK.
# Dos clases:
#  1) Generados (generated_secrets): el modulo crea el valor aleatorio (JWT
#     signing keys, HMAC interno, claves de panico) y lo guarda. Nunca en tfvars.
#  2) Placeholder (managed_secrets): se crea el secret vacio/rotacion manual y
#     el valor se inyecta fuera de Terraform (p.ej. claves de proveedor externo,
#     credenciales que un operador rellena via consola/CLI).
#
# Los valores generados NO aparecen en codigo ni en tfvars; viven en el state
# (cifrado) y en Secrets Manager. Los pods los leen via IRSA + CSI/SDK.

locals {
  prefix = "veo/${var.env}"
}

# ---------------------------------------------------------------------------
# Secretos generados (random)
# ---------------------------------------------------------------------------
resource "random_password" "generated" {
  for_each = var.generated_secrets

  length           = each.value.length
  special          = each.value.special
  override_special = each.value.override_special
}

resource "aws_secretsmanager_secret" "generated" {
  for_each = var.generated_secrets

  name        = "${local.prefix}/${each.value.path}"
  description = each.value.description
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Name = "${local.prefix}/${each.value.path}"
    Kind = "generated"
  })
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each = var.generated_secrets

  secret_id = aws_secretsmanager_secret.generated[each.key].id
  # Si json_key esta definido, se guarda como {"<key>": "<value>"}; si no, raw.
  secret_string = each.value.json_key != "" ? jsonencode({
    (each.value.json_key) = random_password.generated[each.key].result
  }) : random_password.generated[each.key].result
}

# ---------------------------------------------------------------------------
# Secretos keypair (asimetricos, p.ej. ES256 para JWT)
# Un secret JSON con private_key_pem + public_key_pem.
# ---------------------------------------------------------------------------
resource "tls_private_key" "keypair" {
  for_each = var.keypair_secrets

  algorithm   = each.value.algorithm
  ecdsa_curve = each.value.ecdsa_curve
}

resource "aws_secretsmanager_secret" "keypair" {
  for_each = var.keypair_secrets

  name        = "${local.prefix}/${each.value.path}"
  description = each.value.description
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Name = "${local.prefix}/${each.value.path}"
    Kind = "keypair"
  })
}

resource "aws_secretsmanager_secret_version" "keypair" {
  for_each = var.keypair_secrets

  secret_id = aws_secretsmanager_secret.keypair[each.key].id
  secret_string = jsonencode({
    private_key_pem = tls_private_key.keypair[each.key].private_key_pem
    public_key_pem  = tls_private_key.keypair[each.key].public_key_pem
  })
}

# ---------------------------------------------------------------------------
# Secretos placeholder (valor inyectado fuera de Terraform)
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "managed" {
  for_each = var.managed_secrets

  name        = "${local.prefix}/${each.value.path}"
  description = each.value.description
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Name = "${local.prefix}/${each.value.path}"
    Kind = "managed"
  })
}

# Version placeholder inicial; Terraform ignora cambios posteriores al valor.
resource "aws_secretsmanager_secret_version" "managed" {
  for_each = var.managed_secrets

  secret_id     = aws_secretsmanager_secret.managed[each.key].id
  secret_string = jsonencode({ placeholder = "REPLACE_ME_OUT_OF_BAND" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
