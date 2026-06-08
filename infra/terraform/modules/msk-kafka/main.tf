# Module: msk-kafka
# Amazon MSK (Managed Kafka) multi-AZ: brokers distribuidos en las subnets de BD
# (una por AZ), cifrado at-rest (KMS) e in-transit (TLS), IAM auth, logging a
# CloudWatch. Soberania: Kafka propio gestionado en AWS, sin SaaS de terceros.

locals {
  name = "${var.project}-${var.env}-msk"
}

resource "aws_security_group" "this" {
  name        = "${local.name}-sg"
  description = "MSK access for ${local.name}"
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

# TLS (9094) e IAM (9098) desde los SGs autorizados.
resource "aws_security_group_rule" "ingress_tls" {
  for_each                 = toset(var.allowed_security_group_ids)
  type                     = "ingress"
  from_port                = 9094
  to_port                  = 9094
  protocol                 = "tcp"
  security_group_id        = aws_security_group.this.id
  source_security_group_id = each.value
  description              = "Kafka TLS from authorized SG"
}

resource "aws_security_group_rule" "ingress_iam" {
  for_each                 = toset(var.allowed_security_group_ids)
  type                     = "ingress"
  from_port                = 9098
  to_port                  = 9098
  protocol                 = "tcp"
  security_group_id        = aws_security_group.this.id
  source_security_group_id = each.value
  description              = "Kafka IAM SASL from authorized SG"
}

resource "aws_msk_configuration" "this" {
  kafka_versions = [var.kafka_version]
  name           = "${local.name}-config"

  server_properties = <<-PROPERTIES
    auto.create.topics.enable=${var.auto_create_topics}
    default.replication.factor=${var.default_replication_factor}
    min.insync.replicas=${var.min_insync_replicas}
    num.partitions=${var.num_partitions}
    log.retention.hours=${var.log_retention_hours}
  PROPERTIES
}

resource "aws_cloudwatch_log_group" "broker" {
  name              = "/veo/${var.env}/msk/broker-logs"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

resource "aws_msk_cluster" "this" {
  cluster_name           = local.name
  kafka_version          = var.kafka_version
  number_of_broker_nodes = var.number_of_broker_nodes # debe ser multiplo de #AZ

  broker_node_group_info {
    instance_type   = var.broker_instance_type
    client_subnets  = var.subnet_ids
    security_groups = [aws_security_group.this.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.broker_volume_size
      }
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.this.arn
    revision = aws_msk_configuration.this.latest_revision
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = var.kms_key_arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl {
      iam = true
    }
    tls {}
  }

  enhanced_monitoring = var.enhanced_monitoring

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.broker.name
      }
    }
  }

  tags = merge(var.tags, { Name = local.name })
}
