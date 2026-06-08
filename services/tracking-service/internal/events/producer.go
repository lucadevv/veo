package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// Publisher abstrae la publicación de envelopes (DIP: los servicios dependen de esto, no de Kafka).
type Publisher interface {
	Publish(ctx context.Context, env EventEnvelope, key string) error
	Close() error
}

// KafkaProducer publica EventEnvelope a Kafka enrutando por dominio.
type KafkaProducer struct {
	writer *kafka.Writer
}

// NewKafkaProducer crea un productor con balanceo por hash de key (orden por entidad).
func NewKafkaProducer(brokers []string, clientID string) *KafkaProducer {
	return &KafkaProducer{
		writer: &kafka.Writer{
			Addr:                   kafka.TCP(brokers...),
			Balancer:               &kafka.Hash{}, // misma key → misma partición → orden por driver
			RequiredAcks:           kafka.RequireAll,
			AllowAutoTopicCreation: true,
			BatchTimeout:           10 * time.Millisecond,
			WriteTimeout:           10 * time.Second,
			Async:                  false,
			Transport: &kafka.Transport{
				ClientID: clientID,
			},
		},
	}
}

// Publish serializa el envelope y lo envía al topic del dominio con la key dada.
func (p *KafkaProducer) Publish(ctx context.Context, env EventEnvelope, key string) error {
	value, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("events: marshal envelope %s: %w", env.EventType, err)
	}
	msg := kafka.Message{
		Topic: TopicForEvent(env.EventType),
		Key:   []byte(key),
		Value: value,
		Headers: []kafka.Header{
			{Key: "eventType", Value: []byte(env.EventType)},
		},
	}
	if err := p.writer.WriteMessages(ctx, msg); err != nil {
		return fmt.Errorf("events: publish %s: %w", env.EventType, err)
	}
	return nil
}

// Close cierra el writer de Kafka.
func (p *KafkaProducer) Close() error {
	if err := p.writer.Close(); err != nil {
		return fmt.Errorf("events: close writer: %w", err)
	}
	return nil
}
