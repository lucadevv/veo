package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/obs"
)

// Processor procesa un ping ya deserializado.
type Processor interface {
	Process(ctx context.Context, ping domain.Ping) error
}

// MQTTConfig configura la conexión al broker MQTT.
type MQTTConfig struct {
	BrokerURL string
	Username  string
	Password  string
	ClientID  string
	Topic     string
	QoS       byte
}

// MQTTConsumer suscribe a los topics de GPS y enruta cada ping al Processor.
type MQTTConsumer struct {
	client mqtt.Client
	topic  string
	qos    byte
	proc   Processor
	log    *slog.Logger
}

// wirePing es el formato JSON que publican los conductores por MQTT.
type wirePing struct {
	DriverID   string  `json:"driverId"`
	TripID     string  `json:"tripId"`
	Lat        float64 `json:"lat"`
	Lon        float64 `json:"lon"`
	Speed      float64 `json:"speed"`
	Heading    float64 `json:"heading"`
	Accuracy   float64 `json:"accuracy"`
	RecordedAt string  `json:"recordedAt"` // RFC3339; vacío → ahora
}

// NewMQTTConsumer crea (sin conectar) el consumidor MQTT.
func NewMQTTConsumer(cfg MQTTConfig, proc Processor, log *slog.Logger) *MQTTConsumer {
	c := &MQTTConsumer{topic: cfg.Topic, qos: cfg.QoS, proc: proc, log: log}

	opts := mqtt.NewClientOptions().
		AddBroker(cfg.BrokerURL).
		SetClientID(cfg.ClientID).
		SetUsername(cfg.Username).
		SetPassword(cfg.Password).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetMaxReconnectInterval(30 * time.Second).
		SetCleanSession(false).
		SetOrderMatters(false).
		SetKeepAlive(30 * time.Second).
		SetOnConnectHandler(c.onConnect).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Warn("mqtt: conexión perdida", slog.Any("err", err))
		})

	c.client = mqtt.NewClient(opts)
	return c
}

// Start conecta al broker y se suscribe (la suscripción real ocurre en onConnect).
func (c *MQTTConsumer) Start(ctx context.Context) error {
	token := c.client.Connect()
	if !token.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("ingest: timeout conectando a MQTT")
	}
	if err := token.Error(); err != nil {
		return fmt.Errorf("ingest: conectar MQTT: %w", err)
	}
	return nil
}

func (c *MQTTConsumer) onConnect(client mqtt.Client) {
	token := client.Subscribe(c.topic, c.qos, c.handleMessage)
	token.Wait()
	if err := token.Error(); err != nil {
		c.log.Error("mqtt: fallo al suscribir", slog.String("topic", c.topic), slog.Any("err", err))
		return
	}
	c.log.Info("mqtt: suscrito a topic de GPS", slog.String("topic", c.topic))
}

func (c *MQTTConsumer) handleMessage(_ mqtt.Client, msg mqtt.Message) {
	var wp wirePing
	if err := json.Unmarshal(msg.Payload(), &wp); err != nil {
		c.log.Warn("mqtt: payload no decodificable", slog.Any("err", err))
		return
	}

	driverID := wp.DriverID
	if driverID == "" {
		driverID = driverFromTopic(msg.Topic())
	}

	recordedAt := time.Now().UTC()
	if wp.RecordedAt != "" {
		if t, err := time.Parse(time.RFC3339Nano, wp.RecordedAt); err == nil {
			recordedAt = t
		}
	}

	ping := domain.Ping{
		DriverID:   driverID,
		TripID:     wp.TripID,
		Lat:        wp.Lat,
		Lon:        wp.Lon,
		Speed:      wp.Speed,
		Heading:    wp.Heading,
		Accuracy:   wp.Accuracy,
		RecordedAt: recordedAt,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.proc.Process(ctx, ping); err != nil {
		c.log.Error("ingest: fallo procesando ping",
			slog.String("driver", obs.RedactDriverID(driverID)), slog.Any("err", err))
	}
}

// driverFromTopic extrae el driverId de veo/driver/{id}/location.
func driverFromTopic(topic string) string {
	parts := strings.Split(topic, "/")
	for i, p := range parts {
		if p == "driver" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

// Ping verifica que el cliente esté conectado (readiness).
func (c *MQTTConsumer) Ping(_ context.Context) error {
	if !c.client.IsConnectionOpen() {
		return fmt.Errorf("ingest: MQTT desconectado")
	}
	return nil
}

// Close desconecta del broker.
func (c *MQTTConsumer) Close() {
	c.client.Disconnect(500)
}
