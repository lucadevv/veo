# Module: iot-core
# AWS IoT Core para MQTT (telemetria de dispositivos / tracking de flota).
# Thing type/group, policy de dispositivo restringida por clientId, y topic
# rules que enrutan a MSK/Kinesis/Lambda. Soberania: broker MQTT propio en AWS.

locals {
  name = "${var.project}-${var.env}-iot"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_iot_thing_type" "this" {
  name = "${local.name}-${var.thing_type_name}"

  tags = merge(var.tags, { Name = "${local.name}-${var.thing_type_name}" })
}

resource "aws_iot_thing_group" "this" {
  name = "${local.name}-${var.thing_group_name}"

  tags = merge(var.tags, { Name = "${local.name}-${var.thing_group_name}" })
}

# Policy de dispositivo: connect solo con clientId == thingName; pub/sub limitado
# a los topics del propio dispositivo (sustitucion por ${iot:Connection...}).
resource "aws_iot_policy" "device" {
  name = "${local.name}-device-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["arn:aws:iot:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:client/$${iot:Connection.Thing.ThingName}"]
      },
      {
        Effect = "Allow"
        Action = ["iot:Publish", "iot:Receive"]
        Resource = [
          "arn:aws:iot:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:topic/${var.topic_prefix}/$${iot:Connection.Thing.ThingName}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Subscribe"]
        Resource = ["arn:aws:iot:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:topicfilter/${var.topic_prefix}/$${iot:Connection.Thing.ThingName}/*"]
      },
    ]
  })

  tags = var.tags
}

# Rol que asumen las topic rules para republicar / escribir a destinos.
resource "aws_iam_role" "rule" {
  count = var.create_republish_rule ? 1 : 0
  name  = "${local.name}-rule-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "rule" {
  count = var.create_republish_rule ? 1 : 0
  name  = "${local.name}-rule-policy"
  role  = aws_iam_role.rule[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["iot:Publish"]
      Resource = ["arn:aws:iot:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:topic/${var.republish_topic}"]
    }]
  })
}

# Regla ejemplo: reenvia telemetria a un topic interno consumido por backend.
resource "aws_iot_topic_rule" "republish" {
  count       = var.create_republish_rule ? 1 : 0
  name        = replace("${local.name}_telemetry", "-", "_")
  enabled     = true
  sql         = "SELECT * FROM '${var.topic_prefix}/+/telemetry'"
  sql_version = "2016-03-23"

  republish {
    role_arn = aws_iam_role.rule[0].arn
    topic    = var.republish_topic
    qos      = 1
  }

  tags = var.tags
}

# Logging de IoT Core a CloudWatch (auditoria).
resource "aws_iam_role" "logging" {
  count = var.enable_logging ? 1 : 0
  name  = "${local.name}-logging-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "logging" {
  count      = var.enable_logging ? 1 : 0
  role       = aws_iam_role.logging[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSIoTLogging"
}

resource "aws_iot_logging_options" "this" {
  count             = var.enable_logging ? 1 : 0
  default_log_level = var.log_level
  role_arn          = aws_iam_role.logging[0].arn
}
