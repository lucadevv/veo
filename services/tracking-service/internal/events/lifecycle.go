package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"
)

// DriverStatus refleja el estado operativo del conductor según el ciclo de vida del viaje. El
// LifecycleConsumer depende de esta abstracción (DIP); presence.StatusStore la satisface.
type DriverStatus interface {
	// SetBusy marca al conductor ocupado (en viaje) → fuera del hot index de dispatch.
	SetBusy(ctx context.Context, driverID string) error
	// Clear libera al conductor (viaje terminado/cancelado) → disponible.
	Clear(ctx context.Context, driverID string) error
}

// LifecycleConsumer consume el ciclo de vida del viaje (topic "trip") y mantiene el estado operativo del
// conductor en la presencia: trip.assigned → busy; trip.completed/cancelled → disponible. Sin esto, la
// pipeline marcaba a TODO conductor como disponible en cada ping (un conductor en viaje seguía siendo
// "matchable" por dispatch → doble-booking). Usa offsets manuales: si falla, no commitea y Kafka reentrega.
type LifecycleConsumer struct {
	reader *kafka.Reader
	status DriverStatus
	log    *slog.Logger
}

// NewLifecycleConsumer crea (sin arrancar) el consumidor del ciclo de vida del viaje.
func NewLifecycleConsumer(cfg ConsumerConfig, status DriverStatus, log *slog.Logger) *LifecycleConsumer {
	if cfg.GroupID == "" {
		cfg.GroupID = "tracking-service.lifecycle"
	}
	if cfg.Topic == "" {
		cfg.Topic = TopicForEvent(EventTripAssigned) // "trip"
	}
	if log == nil {
		log = slog.Default()
	}
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: cfg.Brokers,
		GroupID: cfg.GroupID,
		Topic:   cfg.Topic,
	})
	return &LifecycleConsumer{reader: reader, status: status, log: log}
}

// Start arranca el loop de consumo en una goroutine y retorna de inmediato.
func (c *LifecycleConsumer) Start(ctx context.Context) {
	go c.run(ctx)
}

func (c *LifecycleConsumer) run(ctx context.Context) {
	c.log.Info("kafka: suscrito al ciclo de vida del viaje (status del conductor)",
		slog.String("topic", c.reader.Config().Topic),
		slog.String("group", c.reader.Config().GroupID),
	)
	var backoff time.Duration
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, kafka.ErrGroupClosed) {
				return
			}
			backoff = nextReadBackoff(backoff)
			c.log.Warn("kafka: error leyendo mensaje; reintento con backoff",
				slog.Any("err", err), slog.Duration("backoff", backoff))
			if !sleepCtx(ctx, backoff) {
				return
			}
			continue
		}
		backoff = 0 // fetch exitoso: resetea el backoff
		if err := c.handle(ctx, msg.Value); err != nil {
			c.log.Error("kafka: fallo procesando evento de viaje; sin commit, se reintentará", slog.Any("err", err))
			continue
		}
		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Warn("kafka: fallo al commitear offset", slog.Any("err", err))
		}
	}
}

// handle decodifica el envelope y actualiza el estado operativo del conductor. El topic "trip" trae
// muchos eventos; solo nos interesan assigned/completed/cancelled. Eventos sin driverId se ignoran sin
// error (idempotente). Un envelope malformado se descarta (commit) para no bloquear la partición.
func (c *LifecycleConsumer) handle(ctx context.Context, value []byte) error {
	var env EventEnvelope
	if err := json.Unmarshal(value, &env); err != nil {
		c.log.Warn("kafka: envelope de viaje no decodificable; ignorado", slog.Any("err", err))
		return nil
	}

	switch env.EventType {
	case EventTripAssigned:
		payload, err := decodePayload[TripAssigned](env.Payload)
		if err != nil {
			c.log.Warn("kafka: trip.assigned con payload inválido; ignorado", slog.Any("err", err))
			return nil
		}
		if payload.DriverID == "" {
			return nil
		}
		if err := c.status.SetBusy(ctx, payload.DriverID); err != nil {
			return fmt.Errorf("lifecycle: marcar busy driver=%s: %w", payload.DriverID, err)
		}
		c.log.Debug("conductor en viaje (busy)", slog.String("driver", payload.DriverID), slog.String("trip", payload.TripID))
		return nil

	case EventTripCompleted:
		payload, err := decodePayload[TripCompleted](env.Payload)
		if err != nil {
			c.log.Warn("kafka: trip.completed con payload inválido; ignorado", slog.Any("err", err))
			return nil
		}
		return c.release(ctx, payload.DriverID, payload.TripID)

	case EventTripCancelled:
		payload, err := decodePayload[TripCancelled](env.Payload)
		if err != nil {
			c.log.Warn("kafka: trip.cancelled con payload inválido; ignorado", slog.Any("err", err))
			return nil
		}
		return c.release(ctx, payload.DriverID, payload.TripID)

	default:
		// Otro evento del topic "trip" (requested, started, etc.): no afecta el status operativo.
		return nil
	}
}

// release libera al conductor (viaje terminado/cancelado) → vuelve a disponible. Sin driverId no hay
// nada que liberar (el viaje no tenía conductor asignado).
func (c *LifecycleConsumer) release(ctx context.Context, driverID, tripID string) error {
	if driverID == "" {
		return nil
	}
	if err := c.status.Clear(ctx, driverID); err != nil {
		return fmt.Errorf("lifecycle: liberar driver=%s: %w", driverID, err)
	}
	c.log.Debug("conductor liberado (disponible)", slog.String("driver", driverID), slog.String("trip", tripID))
	return nil
}

// Close detiene el consumidor cerrando el reader.
func (c *LifecycleConsumer) Close() error {
	if err := c.reader.Close(); err != nil {
		return fmt.Errorf("events: cerrar reader lifecycle: %w", err)
	}
	return nil
}
