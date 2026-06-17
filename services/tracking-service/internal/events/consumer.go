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

// Backoff del read-loop de los consumers ante errores PERSISTENTES de FetchMessage (p.ej. broker
// inalcanzable / EOF). Sin esto el loop hace `continue` instantáneo y, con un error persistente, inunda
// el log (millones de líneas) y tumba el proceso. Crece exponencialmente hasta un techo; se resetea al
// primer fetch exitoso.
//
// El EOF al arranque es TRANSITORIO (kafka todavía no listo cuando el servicio levanta): el backoff lo
// absorbe y los consumers se recuperan solos al conectar. Verificado en vivo: con kafka arriba hay 0 EOF
// y tracking produce/consume OK (ready-check kafka=up, publish driver.location_updated). Sin el backoff,
// ese transitorio inundaba el log (millones de líneas) y tumbaba el proceso.
const (
	readBackoffInitial = 250 * time.Millisecond
	readBackoffMax     = 5 * time.Second
)

// nextReadBackoff devuelve el siguiente backoff (exponencial, capeado). cur==0 ⇒ el inicial.
func nextReadBackoff(cur time.Duration) time.Duration {
	if cur <= 0 {
		return readBackoffInitial
	}
	if next := cur * 2; next < readBackoffMax {
		return next
	}
	return readBackoffMax
}

// sleepCtx duerme d o hasta que ctx se cancele. Devuelve false si se canceló (el loop debe salir).
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Eraser borra el histórico GPS de un conductor (derecho al olvido, Ley 29733).
// history.Store lo satisface; el consumer depende de esta abstracción (DIP).
type Eraser interface {
	Delete(ctx context.Context, driverID string) error
}

// ConsumerConfig configura el consumidor de eventos de borrado.
type ConsumerConfig struct {
	Brokers []string
	// GroupID del consumer group. Por defecto "tracking-service.erasure".
	GroupID string
	// Topic del dominio "user". Por defecto el de EventUserDeleted.
	Topic string
}

// ErasureConsumer consume user.deleted y purga el histórico GPS del conductor.
// Usa offsets manuales: si el borrado falla, no commitea y Kafka reentrega (retry).
type ErasureConsumer struct {
	reader *kafka.Reader
	eraser Eraser
	log    *slog.Logger
}

// NewErasureConsumer crea (sin arrancar) el consumidor de borrado.
func NewErasureConsumer(cfg ConsumerConfig, eraser Eraser, log *slog.Logger) *ErasureConsumer {
	if cfg.GroupID == "" {
		cfg.GroupID = "tracking-service.erasure"
	}
	if cfg.Topic == "" {
		cfg.Topic = TopicForEvent(EventUserDeleted)
	}
	if log == nil {
		log = slog.Default()
	}
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: cfg.Brokers,
		GroupID: cfg.GroupID,
		Topic:   cfg.Topic,
	})
	return &ErasureConsumer{reader: reader, eraser: eraser, log: log}
}

// Start arranca el loop de consumo en una goroutine y retorna de inmediato.
// El loop termina cuando ctx se cancela o el reader se cierra.
func (c *ErasureConsumer) Start(ctx context.Context) {
	go c.run(ctx)
}

func (c *ErasureConsumer) run(ctx context.Context) {
	c.log.Info("kafka: suscrito a user.deleted (derecho al olvido)",
		slog.String("topic", c.reader.Config().Topic),
		slog.String("group", c.reader.Config().GroupID),
	)
	var backoff time.Duration
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			// Cancelación/cierre: salida limpia.
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
			// No commiteamos el offset → Kafka reentrega el mensaje (retry).
			c.log.Error("kafka: fallo procesando user.deleted; sin commit, se reintentará",
				slog.Any("err", err))
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

// handle decodifica el envelope y, si es user.deleted con driverId, purga el histórico.
// Idempotente: eventos sin driverId (pasajeros) o de otro tipo se ignoran sin error.
func (c *ErasureConsumer) handle(ctx context.Context, value []byte) error {
	var env EventEnvelope
	if err := json.Unmarshal(value, &env); err != nil {
		// Mensaje malformado: no es reintentable, lo descartamos (commit) para no bloquear.
		c.log.Warn("kafka: envelope no decodificable; ignorado", slog.Any("err", err))
		return nil
	}
	if env.EventType != EventUserDeleted {
		// El topic "user" puede traer otros eventos; sólo nos interesa el borrado.
		return nil
	}

	payload, err := decodePayload[UserDeleted](env.Payload)
	if err != nil {
		c.log.Warn("kafka: user.deleted con payload inválido; ignorado", slog.Any("err", err))
		return nil
	}
	if payload.DriverID == "" {
		// El usuario borrado no era conductor: no hay histórico GPS que purgar.
		return nil
	}

	if err := c.eraser.Delete(ctx, payload.DriverID); err != nil {
		return fmt.Errorf("events: borrar histórico driver=%s: %w", payload.DriverID, err)
	}
	c.log.Info("histórico GPS purgado por borrado de usuario", slog.String("driver", payload.DriverID))
	return nil
}

// Close detiene el consumidor cerrando el reader.
func (c *ErasureConsumer) Close() error {
	if err := c.reader.Close(); err != nil {
		return fmt.Errorf("events: cerrar reader: %w", err)
	}
	return nil
}

// decodePayload re-serializa el payload genérico (any) y lo decodifica al tipo T.
// EventEnvelope.Payload llega como map[string]any tras json.Unmarshal.
func decodePayload[T any](payload any) (T, error) {
	var out T
	raw, err := json.Marshal(payload)
	if err != nil {
		return out, fmt.Errorf("events: re-serializar payload: %w", err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("events: decodificar payload: %w", err)
	}
	return out, nil
}
