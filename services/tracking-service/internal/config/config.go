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
	// Entorno
	Env string // development|test|production; gobierna el fail-fast de secretos

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

	// Reaper (anti-leak del estado en memoria)
	ReapInterval     time.Duration // cada cuánto barre el estado en memoria de conductores inactivos
	DriverStaleAfter time.Duration // inactividad (sin pings) tras la cual se evicta el estado del conductor

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
		Env:                     appEnv(),
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
		ReapInterval:            envDuration("REAP_INTERVAL", 30*time.Second),
		DriverStaleAfter:        envDuration("DRIVER_STALE_AFTER", 2*time.Minute),
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
	return c.validateSecrets()
}

// devClickHousePassword es la credencial conocida del dev-stack local.
// En producción su presencia (o un password vacío) debe abortar el boot:
// degradar en silencio a la credencial dev es una vulnerabilidad.
const devClickHousePassword = "veo_dev"

// validateSecrets aplica fail-fast a los secretos cuando el entorno es producción.
//
// Replica la semántica del helper `secret()` de los servicios Node: en
// development/test los defaults del dev-stack siguen vigentes (no rompemos el
// arranque local), pero en producción un secreto faltante o con el valor de
// desarrollo aborta el boot con un error explícito en vez de degradar en
// silencio a una credencial conocida.
func (c Config) validateSecrets() error {
	if !c.isProduction() {
		return nil
	}

	// ClickHouse (histórico GPS): el password es obligatorio en producción y
	// jamás puede ser la credencial conocida del dev-stack.
	if c.ClickHousePassword == "" {
		return fmt.Errorf("config: CLICKHOUSE_PASSWORD requerido en producción")
	}
	if c.ClickHousePassword == devClickHousePassword {
		return fmt.Errorf("config: CLICKHOUSE_PASSWORD no puede ser la credencial de desarrollo (%q) en producción", devClickHousePassword)
	}

	// MQTT (ingesta GPS): el cliente sólo soporta autenticación user/pass
	// (paho, sin mTLS configurable). Si en producción se declara un usuario,
	// el password no puede quedar vacío — una auth a medias conectaría al
	// broker sin credencial. Si no hay usuario (broker sin-auth o mTLS gestionado
	// fuera del proceso), no se fuerza el password.
	if c.MQTTUsername != "" && c.MQTTPassword == "" {
		return fmt.Errorf("config: MQTT_PASSWORD requerido en producción cuando MQTT_USERNAME está definido")
	}

	return nil
}

// isProduction indica si el servicio corre en el entorno de producción.
func (c Config) isProduction() bool {
	return strings.EqualFold(c.Env, "production")
}

// appEnv resuelve el entorno de ejecución. El manifiesto K8s del tracking-service
// inyecta NODE_ENV (hereda el template de los servicios Node); el biometric-service
// y otros usan APP_ENV. Aceptamos ambos para ser idiomáticos con el repo, con
// NODE_ENV como fuente primaria. Default seguro para desarrollo local.
func appEnv() string {
	if v := env("APP_ENV", ""); v != "" {
		return v
	}
	return env("NODE_ENV", "development")
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
