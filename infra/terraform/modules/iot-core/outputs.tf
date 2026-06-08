# Module: iot-core · outputs

output "thing_type_name" {
  value = aws_iot_thing_type.this.name
}

output "thing_group_arn" {
  value = aws_iot_thing_group.this.arn
}

output "device_policy_name" {
  value = aws_iot_policy.device.name
}

output "device_policy_arn" {
  value = aws_iot_policy.device.arn
}

output "republish_topic" {
  value = var.create_republish_rule ? var.republish_topic : null
}
