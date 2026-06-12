# envs/prod · composicion de modulos
# Cableado: VPC -> EKS -> RDS/Redis/MSK/S3/IoT, KMS por dominio, IRSA, secretos.
# prod: multi-AZ (3 AZ), deletion protection, backups, KMS, NAT por AZ.

# ---------------------------------------------------------------------------
# KMS — keys por dominio (pii/biometric/video/audit)
# ---------------------------------------------------------------------------
module "kms" {
  source = "../../modules/kms"

  project = "veo"
  env     = var.env
  tags    = local.common_tags
}

# ---------------------------------------------------------------------------
# Red
# ---------------------------------------------------------------------------
module "vpc" {
  source = "../../modules/vpc"

  project            = "veo"
  env                = var.env
  region             = var.region
  cidr_block         = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = false # prod: NAT por AZ
  enable_flow_logs   = true
  tags               = local.common_tags
}

# ---------------------------------------------------------------------------
# EKS
# ---------------------------------------------------------------------------
module "eks" {
  source = "../../modules/eks"

  project             = "veo"
  env                 = var.env
  cluster_version     = var.cluster_version
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  public_subnet_ids   = module.vpc.public_subnet_ids
  secrets_kms_key_arn = module.kms.key_arns["pii"]
  public_access_cidrs = var.eks_public_access_cidrs

  node_groups = {
    general = {
      instance_types = ["m6i.large"]
      capacity_type  = "ON_DEMAND"
      desired_size   = 3
      min_size       = 3
      max_size       = 9
      labels         = { workload = "general" }
    }
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# IRSA — un rol por service account de los ~17 servicios
# ---------------------------------------------------------------------------
module "iam_irsa" {
  source = "../../modules/iam-roles"

  project           = "veo"
  env               = var.env
  namespace         = local.namespace
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  service_accounts  = local.service_accounts

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Secretos de aplicacion (JWT, HMAC, panic) cifrados con CMK pii
# ---------------------------------------------------------------------------
module "app_secrets" {
  source = "../../modules/secrets-manager"

  env               = var.env
  kms_key_arn       = module.kms.key_arns["pii"]
  generated_secrets = local.generated_secrets
  keypair_secrets   = local.keypair_secrets
  managed_secrets   = local.managed_secrets
  tags              = local.common_tags
}

# ---------------------------------------------------------------------------
# RDS por servicio critico (identity/payment/panic/audit)
# ---------------------------------------------------------------------------
module "rds" {
  source   = "../../modules/rds-postgres"
  for_each = toset(local.critical_db_services)

  project = "veo"
  env     = var.env
  service = each.value

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage
  database_name     = each.value

  multi_az                = true
  backup_retention_period = 30
  deletion_protection     = true
  skip_final_snapshot     = false

  kms_key_arn         = module.kms.key_arns[each.value == "audit" ? "audit" : "pii"]
  secrets_kms_key_arn = module.kms.key_arns["pii"]

  tags = local.common_tags
}

# RDS compartida para los servicios no-criticos.
module "rds_shared" {
  source = "../../modules/rds-postgres"

  project = "veo"
  env     = var.env
  service = "shared"

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage
  database_name     = "veo_shared"

  multi_az                = true
  backup_retention_period = 14
  deletion_protection     = true
  skip_final_snapshot     = false

  kms_key_arn         = module.kms.key_arns["pii"]
  secrets_kms_key_arn = module.kms.key_arns["pii"]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ElastiCache Redis (compartido, Multi-AZ)
# ---------------------------------------------------------------------------
module "redis" {
  source = "../../modules/elasticache-redis"

  project     = "veo"
  env         = var.env
  name_suffix = "shared"

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  node_type                  = var.redis_node_type
  multi_az_enabled           = true
  automatic_failover_enabled = true
  num_cache_clusters         = 3

  kms_key_arn         = module.kms.key_arns["pii"]
  secrets_kms_key_arn = module.kms.key_arns["pii"]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# MSK Kafka (3 brokers, uno por AZ)
# ---------------------------------------------------------------------------
module "msk" {
  source = "../../modules/msk-kafka"

  project = "veo"
  env     = var.env

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  number_of_broker_nodes = 3
  broker_instance_type   = var.msk_broker_instance_type
  kms_key_arn            = module.kms.key_arns["pii"]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# S3 buckets
# ---------------------------------------------------------------------------
module "s3_media" {
  source = "../../modules/s3-bucket"

  project       = "veo"
  env           = var.env
  bucket_suffix = "media"
  kms_key_arn   = module.kms.key_arns["video"]

  # Permitir lectura solo via la distribucion CloudFront (OAC).
  cloudfront_distribution_arn = module.cloudfront_media.distribution_arn

  versioning_enabled = true
  lifecycle_rules = [{
    id     = "transition-old-media"
    prefix = ""
    transitions = [
      { days = 90, storage_class = "STANDARD_IA" },
      { days = 365, storage_class = "GLACIER" },
    ]
    noncurrent_version_expiration_days = 90
  }]

  cors_rules = [{
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://*.veo.app"]
  }]

  tags = local.common_tags
}

module "s3_audit" {
  source = "../../modules/s3-bucket"

  project       = "veo"
  env           = var.env
  bucket_suffix = "audit"
  kms_key_arn   = module.kms.key_arns["audit"]

  versioning_enabled  = true
  object_lock_enabled = true # WORM
  object_lock_mode    = "COMPLIANCE"
  object_lock_days    = 2555 # ~7 anos

  tags = local.common_tags
}

module "s3_backups" {
  source = "../../modules/s3-bucket"

  project       = "veo"
  env           = var.env
  bucket_suffix = "backups"
  kms_key_arn   = module.kms.key_arns["pii"]

  versioning_enabled = true
  lifecycle_rules = [{
    id     = "expire-old-backups"
    prefix = ""
    transitions = [
      { days = 30, storage_class = "GLACIER" },
    ]
    expiration_days = 730
  }]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# CloudFront (CDN para media) — provider us-east-1 ya es el region default
# ---------------------------------------------------------------------------
module "cloudfront_media" {
  source = "../../modules/cloudfront"

  project            = "veo"
  env                = var.env
  name_suffix        = "media"
  origin_domain_name = module.s3_media.bucket_domain_name
  price_class        = "PriceClass_100"

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# IoT Core (MQTT telemetria de flota)
# ---------------------------------------------------------------------------
module "iot" {
  source = "../../modules/iot-core"

  project = "veo"
  env     = var.env
  tags    = local.common_tags
}
