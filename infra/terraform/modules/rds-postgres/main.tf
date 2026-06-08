# Module: rds-postgres
# Instancia Postgres por servicio (identity/payment/panic/audit) o compartida
# para los no-criticos. Multi-AZ, cifrado SSE-KMS, backups, deletion protection,
# password generada y almacenada en Secrets Manager (nunca en tfvars).

locals {
  name = "${var.project}-${var.env}-${var.service}"
}

# ---------------------------------------------------------------------------
# Subnet group (database subnets, multi-AZ)
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, {
    Name = "${local.name}-subnet-group"
  })
}

# ---------------------------------------------------------------------------
# Security group — solo permite Postgres desde los SGs/CIDRs autorizados
# ---------------------------------------------------------------------------
resource "aws_security_group" "this" {
  name        = "${local.name}-rds-sg"
  description = "Postgres access for ${local.name}"
  vpc_id      = var.vpc_id

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.name}-rds-sg"
  })
}

resource "aws_security_group_rule" "ingress_sg" {
  for_each                 = toset(var.allowed_security_group_ids)
  type                     = "ingress"
  from_port                = var.port
  to_port                  = var.port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.this.id
  source_security_group_id = each.value
  description              = "Postgres from authorized SG"
}

resource "aws_security_group_rule" "ingress_cidr" {
  count             = length(var.allowed_cidr_blocks) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = var.port
  to_port           = var.port
  protocol          = "tcp"
  security_group_id = aws_security_group.this.id
  cidr_blocks       = var.allowed_cidr_blocks
  description       = "Postgres from authorized CIDRs"
}

# ---------------------------------------------------------------------------
# Master password -> Secrets Manager (generada, nunca en claro/tfvars)
# ---------------------------------------------------------------------------
resource "random_password" "master" {
  length  = 32
  special = true
  # Caracteres no permitidos por RDS para el master password.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "db" {
  name        = "veo/${var.env}/rds/${var.service}"
  description = "Master credentials + connection info for ${local.name}"
  kms_key_id  = var.secrets_kms_key_arn

  recovery_window_in_days = var.secret_recovery_window_days

  tags = merge(var.tags, {
    Name = "${local.name}-db-secret"
  })
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.master_username
    password = random_password.master.result
    engine   = "postgres"
    host     = aws_db_instance.this.address
    port     = var.port
    dbname   = var.database_name
  })
}

# ---------------------------------------------------------------------------
# Parameter group — fuerza SSL/TLS y logging
# ---------------------------------------------------------------------------
resource "aws_db_parameter_group" "this" {
  name        = "${local.name}-pg"
  family      = var.parameter_group_family
  description = "Parameter group for ${local.name}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = merge(var.tags, {
    Name = "${local.name}-pg"
  })
}

# ---------------------------------------------------------------------------
# RDS instance
# ---------------------------------------------------------------------------
resource "aws_db_instance" "this" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = var.storage_type
  iops                  = var.storage_type == "io1" || var.storage_type == "io2" ? var.iops : null

  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  port     = var.port

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name

  # Cifrado en reposo con CMK del dominio correspondiente.
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  # Backups + PITR
  backup_retention_period   = var.backup_retention_period
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  # Observabilidad
  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_kms_key_id       = var.performance_insights_enabled ? var.kms_key_arn : null
  performance_insights_retention_period = var.performance_insights_enabled ? var.performance_insights_retention : null
  monitoring_interval                   = var.monitoring_interval
  monitoring_role_arn                   = var.monitoring_interval > 0 ? aws_iam_role.monitoring[0].arn : null
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  iam_database_authentication_enabled = true

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }

  tags = merge(var.tags, {
    Name    = "${local.name}-pg"
    Service = var.service
  })
}

# ---------------------------------------------------------------------------
# Enhanced monitoring role (optional)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0
  name  = "${local.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count      = var.monitoring_interval > 0 ? 1 : 0
  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---------------------------------------------------------------------------
# Read replica (optional, e.g. audit/identity read scaling)
# ---------------------------------------------------------------------------
resource "aws_db_instance" "replica" {
  count = var.read_replica_count

  identifier          = "${local.name}-pg-replica-${count.index}"
  replicate_source_db = aws_db_instance.this.identifier
  instance_class      = var.replica_instance_class != "" ? var.replica_instance_class : var.instance_class

  storage_encrypted   = true
  kms_key_id          = var.kms_key_arn
  deletion_protection = var.deletion_protection
  skip_final_snapshot = true

  performance_insights_enabled = var.performance_insights_enabled
  monitoring_interval          = var.monitoring_interval
  monitoring_role_arn          = var.monitoring_interval > 0 ? aws_iam_role.monitoring[0].arn : null

  vpc_security_group_ids = [aws_security_group.this.id]
  apply_immediately      = var.apply_immediately

  tags = merge(var.tags, {
    Name    = "${local.name}-pg-replica-${count.index}"
    Service = var.service
    Role    = "read-replica"
  })
}
