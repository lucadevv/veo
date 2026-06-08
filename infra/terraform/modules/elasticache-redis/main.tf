# Module: elasticache-redis
# Redis (replication group) con Multi-AZ + automatic failover, cifrado at-rest
# (KMS) e in-transit (TLS), AUTH token en Secrets Manager. Cluster-mode opcional.

locals {
  name = "${var.project}-${var.env}-redis"
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name}-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, { Name = "${local.name}-subnet-group" })
}

resource "aws_security_group" "this" {
  name        = "${local.name}-sg"
  description = "Redis access for ${local.name}"
  vpc_id      = var.vpc_id

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${local.name}-sg" })
}

resource "aws_security_group_rule" "ingress_sg" {
  for_each                 = toset(var.allowed_security_group_ids)
  type                     = "ingress"
  from_port                = var.port
  to_port                  = var.port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.this.id
  source_security_group_id = each.value
  description              = "Redis from authorized SG"
}

# AUTH token -> Secrets Manager
resource "random_password" "auth" {
  count   = var.transit_encryption_enabled ? 1 : 0
  length  = 64
  special = false # Redis AUTH token: alnum only to be safe
}

resource "aws_secretsmanager_secret" "auth" {
  count       = var.transit_encryption_enabled ? 1 : 0
  name        = "veo/${var.env}/redis/${var.name_suffix}"
  description = "Redis AUTH token + endpoint for ${local.name}"
  kms_key_id  = var.secrets_kms_key_arn

  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = merge(var.tags, { Name = "${local.name}-auth-secret" })
}

resource "aws_secretsmanager_secret_version" "auth" {
  count     = var.transit_encryption_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.auth[0].id
  secret_string = jsonencode({
    auth_token = random_password.auth[0].result
    host       = aws_elasticache_replication_group.this.primary_endpoint_address
    reader     = aws_elasticache_replication_group.this.reader_endpoint_address
    port       = var.port
    tls        = true
  })
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${local.name}-pg"
  family      = var.parameter_group_family
  description = "Parameter group for ${local.name}"

  dynamic "parameter" {
    for_each = var.cluster_mode_enabled ? { "cluster-enabled" = "yes" } : {}
    content {
      name  = parameter.key
      value = parameter.value
    }
  }

  tags = var.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "VEO ${var.env} Redis - ${var.name_suffix}"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = var.port

  parameter_group_name = aws_elasticache_parameter_group.this.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.this.id]

  # HA: Multi-AZ + automatic failover.
  multi_az_enabled           = var.multi_az_enabled
  automatic_failover_enabled = var.automatic_failover_enabled

  # Cluster-mode disabled: single shard, N replicas.
  # Cluster-mode enabled: num_node_groups shards x replicas_per_node_group.
  num_node_groups         = var.cluster_mode_enabled ? var.num_node_groups : null
  replicas_per_node_group = var.cluster_mode_enabled ? var.replicas_per_node_group : null
  num_cache_clusters      = var.cluster_mode_enabled ? null : var.num_cache_clusters

  # Encryption
  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = var.transit_encryption_enabled
  auth_token                 = var.transit_encryption_enabled ? random_password.auth[0].result : null

  # Backups
  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_window
  maintenance_window       = var.maintenance_window

  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  tags = merge(var.tags, { Name = local.name })

  lifecycle {
    ignore_changes = [auth_token]
  }
}
