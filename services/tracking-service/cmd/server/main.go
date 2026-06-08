// Command server arranca el tracking-service de VEO: ingesta GPS por MQTT,
// presencia en Redis, geofencing, histórico en ClickHouse y eventos a Kafka.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"github.com/veo/tracking-service/internal/api"
	"github.com/veo/tracking-service/internal/config"
	"github.com/veo/tracking-service/internal/events"
	"github.com/veo/tracking-service/internal/geofence"
	"github.com/veo/tracking-service/internal/history"
	"github.com/veo/tracking-service/internal/ingest"
	"github.com/veo/tracking-service/internal/obs"
	"github.com/veo/tracking-service/internal/presence"
)

func main() {
	if err := run(); err != nil {
		slog.Error("tracking-service terminó con error", slog.Any("err", err))
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := obs.NewLogger(cfg.LogLevel, cfg.ServiceName)
	slog.SetDefault(log)
	log.Info("iniciando tracking-service",
		slog.String("http", cfg.HTTPAddr),
		slog.String("mqtt_topic", cfg.MQTTTopic),
		slog.Int("h3_res", cfg.H3Resolution),
	)

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- Tracing OTel ---
	shutdownTracing, err := obs.SetupTracing(rootCtx, cfg.OTLPEndpoint, cfg.ServiceName)
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTracing(ctx); err != nil {
			log.Warn("tracing: shutdown con error", slog.Any("err", err))
		}
	}()

	// --- Métricas ---
	registry := prometheus.NewRegistry()
	registry.MustRegister(prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	metrics := obs.NewMetrics(registry)

	// --- Redis (presencia + hot index) ---
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return err
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()
	presenceStore := presence.New(rdb, cfg.PresenceTTL, cfg.H3Resolution)
	// Estado operativo del conductor (busy/available) según el ciclo de vida del viaje (durable en Redis).
	statusStore := presence.NewStatusStore(rdb, cfg.StatusBusyTTL)

	// --- ClickHouse (histórico) ---
	initCtx, cancelInit := context.WithTimeout(rootCtx, 15*time.Second)
	defer cancelInit()
	historyStore, err := history.Open(initCtx, history.Options{
		Addr:     cfg.ClickHouseAddr,
		Database: cfg.ClickHouseDatabase,
		Username: cfg.ClickHouseUser,
		Password: cfg.ClickHousePassword,
		Logger:   log,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := historyStore.Close(); err != nil {
			log.Warn("clickhouse: cierre con error", slog.Any("err", err))
		}
	}()

	// --- Kafka (eventos) ---
	producer := events.NewKafkaProducer(cfg.KafkaBrokers, cfg.KafkaClientID)
	defer func() {
		if err := producer.Close(); err != nil {
			log.Warn("kafka: cierre con error", slog.Any("err", err))
		}
	}()

	// --- Kafka consumer (borrado de histórico: derecho al olvido, Ley 29733) ---
	erasureConsumer := events.NewErasureConsumer(events.ConsumerConfig{
		Brokers: cfg.KafkaBrokers,
	}, historyStore, log)
	erasureConsumer.Start(rootCtx)
	defer func() {
		if err := erasureConsumer.Close(); err != nil {
			log.Warn("kafka: cierre del consumer con error", slog.Any("err", err))
		}
	}()

	// --- Kafka consumer (ciclo de vida del viaje → status del conductor: cierra el doble-booking) ---
	lifecycleConsumer := events.NewLifecycleConsumer(events.ConsumerConfig{
		Brokers: cfg.KafkaBrokers,
	}, statusStore, log)
	lifecycleConsumer.Start(rootCtx)
	defer func() {
		if err := lifecycleConsumer.Close(); err != nil {
			log.Warn("kafka: cierre del consumer de lifecycle con error", slog.Any("err", err))
		}
	}()

	// --- Geofencing ---
	zones, err := geofence.LoadZonesFromFile(cfg.ZonesPath)
	if err != nil {
		return err
	}
	detector, err := geofence.NewDetector(zones)
	if err != nil {
		return err
	}
	log.Info("geofencing listo", slog.Int("zonas", detector.ZoneCount()))

	// --- Fan-out hub ---
	hub := api.NewHub(func(n int) { metrics.StreamSubscribers.Set(float64(n)) })

	// --- Pipeline de ingesta ---
	pipeline := ingest.NewPipeline(ingest.PipelineDeps{
		Presence:     presenceStore,
		Status:       statusStore,
		Geo:          detector,
		History:      historyStore,
		Publisher:    producer,
		Hub:          hub,
		Metrics:      metrics,
		Logger:       log,
		PublishEvery: cfg.LocationPublishInterval,
	})

	// --- MQTT (ingesta) ---
	consumer := ingest.NewMQTTConsumer(ingest.MQTTConfig{
		BrokerURL: cfg.MQTTBrokerURL,
		Username:  cfg.MQTTUsername,
		Password:  cfg.MQTTPassword,
		ClientID:  cfg.MQTTClientID,
		Topic:     cfg.MQTTTopic,
		QoS:       1,
	}, pipeline, log)
	if err := consumer.Start(rootCtx); err != nil {
		return err
	}
	defer consumer.Close()

	// --- Servidor HTTP ---
	srv := api.NewServer(api.ServerDeps{
		Addr:     cfg.HTTPAddr,
		Logger:   log,
		Registry: registry,
		Hub:      hub,
		Resolver: api.NewRedisTripResolver(rdb),
		Checks: map[string]api.HealthCheck{
			"redis":      presenceStore.Ping,
			"clickhouse": historyStore.Ping,
			"kafka":      kafkaCheck(cfg.KafkaBrokers),
			"mqtt":       consumer.Ping,
		},
	})

	srvErr := make(chan error, 1)
	go func() {
		log.Info("HTTP escuchando", slog.String("addr", cfg.HTTPAddr))
		srvErr <- srv.Start()
	}()

	select {
	case <-rootCtx.Done():
		log.Info("señal de apagado recibida, cerrando…")
	case err := <-srvErr:
		if err != nil {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("HTTP: shutdown con error", slog.Any("err", err))
	}
	return nil
}

// kafkaCheck devuelve una verificación de readiness que disca al primer broker.
func kafkaCheck(brokers []string) api.HealthCheck {
	return func(ctx context.Context) error {
		if len(brokers) == 0 {
			return errors.New("kafka: sin brokers configurados")
		}
		d := kafka.Dialer{Timeout: 2 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", brokers[0])
		if err != nil {
			return err
		}
		defer conn.Close()
		if _, err := conn.Brokers(); err != nil {
			return err
		}
		return nil
	}
}
