# envs/dev · composicion de modulos
# Dev mas barato: single NAT, RDS single-AZ, Redis 1 nodo, sin deletion
# protection, skip final snapshot. La red sigue siendo 3-AZ (subnets) para
# paridad estructural, pero las instancias no replican multi-AZ.

module "kms" {
  source  = "../../modules/kms"
  project = "veo"
  env     = var.env
  tags    = local.common_tags
}

module "vpc" {
  source = "../../modules/vpc"

  project            = "veo"
  env                = var.env
  region             = var.region
  cidr_block         = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = true # dev: un solo NAT para ahorrar costo
  enable_flow_logs   = false
  tags               = local.common_tags
}

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
      instance_types = ["t3.large"]
      capacity_type  = "SPOT"
      desired_size   = 2
      min_size       = 1
      max_size       = 4
      labels         = { workload = "general" }
    }
  }

  tags = local.common_tags
}

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

module "app_secrets" {
  source = "../../modules/secrets-manager"

  env                     = var.env
  kms_key_arn             = module.kms.key_arns["pii"]
  generated_secrets       = local.generated_secrets
  managed_secrets         = local.managed_secrets
  recovery_window_in_days = 0 # dev: borrado inmediato al destruir
  tags                    = local.common_tags
}

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

  multi_az                = false
  backup_retention_period = 1
  deletion_protection     = false
  skip_final_snapshot     = true

  performance_insights_enabled = false
  monitoring_interval          = 0

  kms_key_arn                 = module.kms.key_arns[each.value == "audit" ? "audit" : "pii"]
  secrets_kms_key_arn         = module.kms.key_arns["pii"]
  secret_recovery_window_days = 0

  tags = local.common_tags
}

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

  multi_az                = false
  backup_retention_period = 1
  deletion_protection     = false
  skip_final_snapshot     = true

  performance_insights_enabled = false
  monitoring_interval          = 0

  kms_key_arn                 = module.kms.key_arns["pii"]
  secrets_kms_key_arn         = module.kms.key_arns["pii"]
  secret_recovery_window_days = 0

  tags = local.common_tags
}

module "redis" {
  source = "../../modules/elasticache-redis"

  project     = "veo"
  env         = var.env
  name_suffix = "shared"

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  node_type                  = var.redis_node_type
  multi_az_enabled           = false
  automatic_failover_enabled = false
  num_cache_clusters         = 1

  kms_key_arn                 = module.kms.key_arns["pii"]
  secrets_kms_key_arn         = module.kms.key_arns["pii"]
  secret_recovery_window_days = 0

  tags = local.common_tags
}

module "msk" {
  source = "../../modules/msk-kafka"

  project = "veo"
  env     = var.env

  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  number_of_broker_nodes = 3
  broker_instance_type   = var.msk_broker_instance_type
  broker_volume_size     = 20
  kms_key_arn            = module.kms.key_arns["pii"]
  enhanced_monitoring    = "DEFAULT"

  tags = local.common_tags
}

module "s3_media" {
  source = "../../modules/s3-bucket"

  project       = "veo"
  env           = var.env
  bucket_suffix = "media"
  kms_key_arn   = module.kms.key_arns["video"]

  cloudfront_distribution_arn = module.cloudfront_media.distribution_arn

  versioning_enabled = true
  force_destroy      = true # dev: permite teardown limpio

  cors_rules = [{
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["*"]
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
  object_lock_enabled = false # dev: sin WORM para poder limpiar
  force_destroy       = true

  tags = local.common_tags
}

module "s3_backups" {
  source = "../../modules/s3-bucket"

  project       = "veo"
  env           = var.env
  bucket_suffix = "backups"
  kms_key_arn   = module.kms.key_arns["pii"]

  versioning_enabled = false
  force_destroy      = true

  tags = local.common_tags
}

module "cloudfront_media" {
  source = "../../modules/cloudfront"

  project            = "veo"
  env                = var.env
  name_suffix        = "media"
  origin_domain_name = module.s3_media.bucket_domain_name
  price_class        = "PriceClass_100"

  tags = local.common_tags
}

module "iot" {
  source = "../../modules/iot-core"

  project = "veo"
  env     = var.env
  tags    = local.common_tags
}
