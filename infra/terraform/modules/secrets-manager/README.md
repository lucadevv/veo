# Module · secrets-manager

Secretos de aplicacion en AWS Secrets Manager, cifrados con CMK.

- `generated_secrets`: Terraform genera el valor (JWT signing key, HMAC interno,
  claves de panico). El valor nunca aparece en `.tfvars` ni en el codigo.
- `managed_secrets`: se crea el secret con un placeholder; el valor real se
  inyecta fuera de Terraform (operador vía consola/CLI). Terraform ignora cambios
  al valor (`ignore_changes`).

Los pods acceden por IRSA (ver `iam-roles`) + Secrets Store CSI driver o SDK.
