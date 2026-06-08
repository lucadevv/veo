// Package events replica el contrato @veo/events (TS) para publicar a Kafka:
// EventEnvelope JSON idéntico + topic por dominio + key por entidad raíz.
package events

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// SchemaVersion por defecto de los eventos de dominio (FOUNDATION §6).
const SchemaVersion = 1

// EventEnvelope es el sobre único de eventos de dominio. La forma JSON DEBE
// coincidir con `envelopeSchema` de @veo/events: campos opcionales se omiten.
type EventEnvelope struct {
	EventID       string `json:"eventId"`
	EventType     string `json:"eventType"`
	OccurredAt    string `json:"occurredAt"` // ISO-8601 / RFC3339
	Producer      string `json:"producer"`
	TraceID       string `json:"traceId,omitempty"`
	DedupKey      string `json:"dedupKey,omitempty"`
	SchemaVersion int    `json:"schemaVersion"`
	Payload       any    `json:"payload"`
}

// NewEnvelopeInput agrupa los parámetros para construir un envelope.
type NewEnvelopeInput struct {
	EventType  string
	Producer   string
	Payload    any
	TraceID    string
	DedupKey   string
	OccurredAt time.Time // cero → time.Now()
}

// NewEnvelope crea un envelope con eventId UUIDv7 y defaults equivalentes a createEnvelope (TS).
func NewEnvelope(in NewEnvelopeInput) EventEnvelope {
	occurred := in.OccurredAt
	if occurred.IsZero() {
		occurred = time.Now()
	}
	return EventEnvelope{
		EventID:       UUIDv7(occurred),
		EventType:     in.EventType,
		OccurredAt:    occurred.UTC().Format(time.RFC3339Nano),
		Producer:      in.Producer,
		TraceID:       in.TraceID,
		DedupKey:      in.DedupKey,
		SchemaVersion: SchemaVersion,
		Payload:       in.Payload,
	}
}

// TopicForEvent devuelve el topic Kafka: el dominio antes del punto.
// driver.location_updated → "driver".
func TopicForEvent(eventType string) string {
	if i := strings.IndexByte(eventType, '.'); i > 0 {
		return eventType[:i]
	}
	return "misc"
}

// UUIDv7 genera un UUID versión 7 (RFC 9562 §5.7): 48 bits de timestamp ms + aleatorio.
// Idéntico en formato al uuidv7() de @veo/utils para interoperar dedupKeys/ids.
func UUIDv7(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand.Read no falla en la práctica; degradamos a timestamp si ocurriera.
		binary.BigEndian.PutUint64(b[8:], uint64(t.UnixNano()))
	}
	ms := uint64(t.UnixMilli()) & 0xFFFFFFFFFFFF // 48 bits
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0F) | 0x70 // versión 7
	b[8] = (b[8] & 0x3F) | 0x80 // variante RFC 4122

	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}
