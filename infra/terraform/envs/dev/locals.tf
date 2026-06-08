# envs/prod · locals
# Tags obligatorios, naming, mapeo de service accounts -> permisos IRSA.

locals {
  name      = "veo-${var.env}"
  namespace = "veo-${var.env}"

  common_tags = {
    Project    = "veo"
    Env        = var.env
    Owner      = var.owner
    CostCenter = var.cost_center
    ManagedBy  = "terraform"
  }

  # ---------------------------------------------------------------------------
  # Servicios con RDS dedicada (criticos) — RDS por servicio critico.
  # ---------------------------------------------------------------------------
  critical_db_services = ["identity", "payment", "panic", "audit"]

  # Servicios no-criticos que comparten una RDS (con su propia DB logica).
  # trip, dispatch, tracking, media, notification, rating, share, fleet
  shared_db_services = [
    "trip", "dispatch", "tracking", "media",
    "notification", "rating", "share", "fleet",
  ]

  # ---------------------------------------------------------------------------
  # Inventario completo de service accounts (= IRSA roles). 12 svc + 3 bff + 2 fe.
  # ---------------------------------------------------------------------------
  all_service_accounts = [
    "identity-service", "trip-service", "dispatch-service", "tracking-service",
    "media-service", "payment-service", "panic-service", "notification-service",
    "audit-service", "rating-service", "share-service", "fleet-service",
    "admin-bff", "driver-bff", "public-bff",
    "admin-web", "family-web",
  ]

  # Buckets cuyos ARNs necesitan algunos servicios.
  media_bucket_arn  = module.s3_media.bucket_arn
  audit_bucket_arn  = module.s3_audit.bucket_arn
  backup_bucket_arn = module.s3_backups.bucket_arn

  # ARNs de todos los secretos (para scoping de lectura).
  all_app_secret_arns = module.app_secrets.all_secret_arns

  # ---------------------------------------------------------------------------
  # IRSA: statements minimos por service account.
  # Por defecto, todos pueden leer SUS secretos (se restringe por prefijo de path
  # en una mejora futura; aqui se da lectura a los secretos de la app del entorno).
  # ---------------------------------------------------------------------------
  read_app_secrets_stmt = {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = concat(local.all_app_secret_arns, ["arn:aws:secretsmanager:${var.region}:*:secret:veo/${var.env}/*"])
  }

  kms_decrypt_stmt = {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = values(module.kms.key_arns)
  }

  service_accounts = {
    # --- media-service: lee/escribe el bucket de media + firma uploads ---
    "media-service" = {
      statements = [
        local.read_app_secrets_stmt,
        local.kms_decrypt_stmt,
        {
          sid       = "MediaBucketRW"
          actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
          resources = [local.media_bucket_arn, "${local.media_bucket_arn}/*"]
        },
      ]
    }

    # --- audit-service: escribe el bucket WORM de auditoria (no borra) ---
    "audit-service" = {
      statements = [
        local.read_app_secrets_stmt,
        local.kms_decrypt_stmt,
        {
          sid       = "AuditBucketWrite"
          actions   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
          resources = [local.audit_bucket_arn, "${local.audit_bucket_arn}/*"]
        },
      ]
    }

    # --- tracking-service: consume IoT Core (telemetria de flota) ---
    "tracking-service" = {
      statements = [
        local.read_app_secrets_stmt,
        local.kms_decrypt_stmt,
        {
          sid       = "IotConsume"
          actions   = ["iot:Connect", "iot:Subscribe", "iot:Receive", "iot:Publish"]
          resources = ["arn:aws:iot:${var.region}:*:*"]
        },
      ]
    }

    # --- fleet-service: gestiona things/grupos en IoT Core ---
    "fleet-service" = {
      statements = [
        local.read_app_secrets_stmt,
        local.kms_decrypt_stmt,
        {
          sid       = "IotManage"
          actions   = ["iot:CreateThing", "iot:DescribeThing", "iot:AddThingToThingGroup", "iot:ListThings", "iot:AttachPolicy", "iot:UpdateThing"]
          resources = ["arn:aws:iot:${var.region}:*:*"]
        },
      ]
    }

    # --- share-service: firma signed URLs de CloudFront (lectura de media) ---
    "share-service" = {
      statements = [
        local.read_app_secrets_stmt,
        local.kms_decrypt_stmt,
        {
          sid       = "MediaBucketRead"
          actions   = ["s3:GetObject", "s3:ListBucket"]
          resources = [local.media_bucket_arn, "${local.media_bucket_arn}/*"]
        },
      ]
    }

    # --- resto de servicios: solo lectura de secretos + KMS decrypt ---
    "identity-service"     = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "payment-service"      = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "panic-service"        = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "trip-service"         = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "dispatch-service"     = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "notification-service" = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "rating-service"       = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }

    # --- BFFs: leen secretos (firma de tokens de sesion) ---
    "admin-bff"  = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "driver-bff" = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }
    "public-bff" = { statements = [local.read_app_secrets_stmt, local.kms_decrypt_stmt] }

    # --- Frontends estaticos: sin permisos AWS (rol vacio, solo identidad) ---
    "admin-web"  = { statements = [] }
    "family-web" = { statements = [] }
  }

  # ---------------------------------------------------------------------------
  # Secretos de aplicacion generados por Terraform (nunca en tfvars).
  # ---------------------------------------------------------------------------
  generated_secrets = {
    jwt_access = {
      path        = "auth/jwt-access-signing-key"
      description = "JWT access token HMAC signing key"
      length      = 64
      json_key    = "key"
    }
    jwt_refresh = {
      path        = "auth/jwt-refresh-signing-key"
      description = "JWT refresh token HMAC signing key"
      length      = 64
      json_key    = "key"
    }
    internal_hmac = {
      path        = "internal/service-to-service-hmac"
      description = "HMAC key for internal service-to-service auth"
      length      = 64
      json_key    = "key"
    }
    panic_signing = {
      path        = "panic/event-signing-key"
      description = "Signing key for tamper-evident panic events"
      length      = 64
      json_key    = "key"
    }
  }

  # Secretos cuyo valor se inyecta fuera de Terraform (proveedores externos,
  # claves operadas manualmente). Aun asi viven en Secrets Manager.
  managed_secrets = {
    push_credentials = {
      path        = "notification/push-provider-credentials"
      description = "Self-hosted push gateway credentials (filled out-of-band)"
    }
  }
}
