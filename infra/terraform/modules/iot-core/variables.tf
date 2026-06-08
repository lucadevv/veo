# Module: iot-core · variables

variable "project" {
  type    = string
  default = "veo"
}

variable "env" {
  type = string
}

variable "thing_type_name" {
  type    = string
  default = "vehicle"
}

variable "thing_group_name" {
  type    = string
  default = "fleet"
}

variable "topic_prefix" {
  description = "Top-level MQTT topic namespace for devices"
  type        = string
  default     = "veo/devices"
}

variable "create_republish_rule" {
  type    = bool
  default = true
}

variable "republish_topic" {
  description = "Internal topic to republish telemetry to"
  type        = string
  default     = "veo/internal/telemetry"
}

variable "enable_logging" {
  type    = bool
  default = true
}

variable "log_level" {
  type    = string
  default = "WARN"
}

variable "tags" {
  type    = map(string)
  default = {}
}
