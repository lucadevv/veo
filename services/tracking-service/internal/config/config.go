// Package config carga la configuración del servicio desde variables de entorno.
// Sin dependencias externas: tipos concretos y validación explícita.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config agrupa toda la configuración del tracking-service.
type Config struct {
	// HTTP
	HTTPAddr string // dirección de escucha (health/metrics/tracking)

	// MQTT (ingesta GPS)
	MQTTBrokerURL string
	MQTTUsername  string
	MQTTPassword  string
	MQTTClientID  string
	MQTTTopic     string // patrón de suscripción, p.ej. veo/driver/+/location

	// Redis (presencia + hot index H3)
	RedisURL string

	// Kafka (event bus)
	KafkaBrokers  []string
	KafkaClientID string

	// ClickHouse (histórico GPS)
	ClickHouseAddr     string // host:port del protocolo nativo
	ClickHouseDatabase string
	ClickHouseUser     string
	ClickHousePassword string

	// Presencia
	PresenceTTL   time.Duration // TTL de driver:loc:{id}
	StatusBusyTTL time.Duration // red de seguridad del status "busy" si se pierde el trip.completed
	H3Resolution  int           // resolución del hot index (BR: r9)

	// Geofencing
	ZonesPath string // ruta opcional a un JSON con zonas; vacío = solo Lima bbox

	// Eventos
	LocationPublishInterval time.Duration // throttle de driver.location_updated por driver

	// Observabilidad
	OTLPEndpoint string // endpoint OTLP HTTP; vacío = tracing deshabilitado
	LogLevel     string // debug|info|warn|error
	ServiceName  string
}

const producerName = "tracking-service"

// ProducerName es el identificador del productor en el EventEnvelope.
func ProducerName() string { return producerName }

// Load construye la configuración leyendo el entorno con valores por defecto de desarrollo.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:                env("TRACKING_HTTP_ADDR", ":3004"),
		MQTTBrokerURL:           env("MQTT_BROKER_URL", "tcp://localhost:1883"),
		MQTTUsername:            env("MQTT_USERNAME", ""),
		MQTTPassword:            env("MQTT_PASSWORD", ""),
		MQTTClientID:            env("MQTT_CLIENT_ID", "tracking-service"),
		MQTTTopic:               env("MQTT_TOPIC", "veo/driver/+/location"),
		RedisURL:                env("REDIS_URL", "redis://localhost:6379"),
		KafkaBrokers:            splitCSV(env("KAFKA_BROKERS", "localhost:9094")),
		KafkaClientID:           env("KAFKA_CLIENT_ID", "tracking-service"),
		ClickHouseAddr:          env("CLICKHOUSE_ADDR", "localhost:9000"),
		ClickHouseDatabase:      env("CLICKHOUSE_DB", "veo_analytics"),
		ClickHouseUser:          env("CLICKHOUSE_USER", "veo"),
		ClickHousePassword:      env("CLICKHOUSE_PASSWORD", "veo_dev"),
		ZonesPath:               env("TRACKING_ZONES_PATH", ""),
		OTLPEndpoint:            env("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
		LogLevel:                env("LOG_LEVEL", "info"),
		ServiceName:             producerName,
		PresenceTTL:             envDuration("PRESENCE_TTL", 60*time.Second),
		StatusBusyTTL:           envDuration("STATUS_BUSY_TTL", 4*time.Hour),
		H3Resolution:            envInt("H3_RESOLUTION", 9),
		LocationPublishInterval: envDuration("LOCATION_PUBLISH_INTERVAL", 1*time.Second),
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if len(c.KafkaBrokers) == 0 {
		return fmt.Errorf("config: KAFKA_BROKERS vacío")
	}
	if c.H3Resolution < 0 || c.H3Resolution > 15 {
		return fmt.Errorf("config: H3_RESOLUTION fuera de rango [0,15]: %d", c.H3Resolution)
	}
	if c.PresenceTTL <= 0 {
		return fmt.Errorf("config: PRESENCE_TTL debe ser > 0")
	}
	return nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
