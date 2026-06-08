package events

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
)

// fakeEraser registra las llamadas a Delete para verificar el comportamiento del handler.
type fakeEraser struct {
	calls   []string // driverIDs borrados, en orden
	failErr error    // si != nil, Delete falla
}

func (f *fakeEraser) Delete(_ context.Context, driverID string) error {
	if f.failErr != nil {
		return f.failErr
	}
	f.calls = append(f.calls, driverID)
	return nil
}

// newTestConsumer crea un consumer con eraser inyectado, sin reader real de Kafka.
func newTestConsumer(eraser Eraser) *ErasureConsumer {
	return &ErasureConsumer{
		eraser: eraser,
		log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// envBytes serializa un EventEnvelope con el payload dado.
func envBytes(t *testing.T, eventType string, payload any) []byte {
	t.Helper()
	env := NewEnvelope(NewEnvelopeInput{
		EventType: eventType,
		Producer:  "identity-service",
		Payload:   payload,
	})
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return raw
}

func TestErasureConsumerHandle(t *testing.T) {
	tests := []struct {
		name      string
		value     func(t *testing.T) []byte
		wantCalls []string // driverIDs esperados en Delete
		wantErr   bool
	}{
		{
			name: "user.deleted con driverId borra el histórico",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventUserDeleted, UserDeleted{
					UserID: "usr-1", DriverID: "drv-1", At: "2026-06-04T10:00:00Z",
				})
			},
			wantCalls: []string{"drv-1"},
		},
		{
			name: "user.deleted sin driverId se ignora (pasajero)",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventUserDeleted, UserDeleted{
					UserID: "usr-2", At: "2026-06-04T10:00:00Z",
				})
			},
			wantCalls: nil,
		},
		{
			name: "otro tipo de evento en el topic user se ignora",
			value: func(t *testing.T) []byte {
				return envBytes(t, "user.deletion_requested", map[string]any{
					"userId": "usr-3", "requestedAt": "x", "graceUntil": "y",
				})
			},
			wantCalls: nil,
		},
		{
			name: "payload inválido se ignora sin error (commit)",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventUserDeleted, "no-soy-un-objeto")
			},
			wantCalls: nil,
		},
		{
			name: "envelope malformado se ignora sin error (commit)",
			value: func(_ *testing.T) []byte {
				return []byte("{ esto no es json")
			},
			wantCalls: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eraser := &fakeEraser{}
			c := newTestConsumer(eraser)

			err := c.handle(context.Background(), tt.value(t))

			if (err != nil) != tt.wantErr {
				t.Fatalf("handle() err = %v, wantErr %v", err, tt.wantErr)
			}
			if len(eraser.calls) != len(tt.wantCalls) {
				t.Fatalf("Delete llamado %d veces (%v), want %d (%v)",
					len(eraser.calls), eraser.calls, len(tt.wantCalls), tt.wantCalls)
			}
			for i, want := range tt.wantCalls {
				if eraser.calls[i] != want {
					t.Errorf("Delete[%d] = %q, want %q", i, eraser.calls[i], want)
				}
			}
		})
	}
}

// TestErasureConsumerHandleErrorPropagates verifica que un fallo del eraser se
// propague como error (el loop NO commitea → Kafka reintenta).
func TestErasureConsumerHandleErrorPropagates(t *testing.T) {
	eraser := &fakeEraser{failErr: errors.New("clickhouse caído")}
	c := newTestConsumer(eraser)

	value := envBytes(t, EventUserDeleted, UserDeleted{UserID: "u", DriverID: "drv-x", At: "t"})
	if err := c.handle(context.Background(), value); err == nil {
		t.Fatal("se esperaba error cuando el eraser falla, para no commitear el offset")
	}
}

// TestErasureConsumerHandleIdempotent verifica que reprocesar el mismo evento
// vuelve a invocar Delete (que es idempotente a nivel de ClickHouse): no hay
// estado en el handler que rompa al reentregar.
func TestErasureConsumerHandleIdempotent(t *testing.T) {
	eraser := &fakeEraser{}
	c := newTestConsumer(eraser)
	value := envBytes(t, EventUserDeleted, UserDeleted{UserID: "u", DriverID: "drv-dup", At: "t"})

	for i := 0; i < 3; i++ {
		if err := c.handle(context.Background(), value); err != nil {
			t.Fatalf("reintento %d: %v", i, err)
		}
	}
	want := []string{"drv-dup", "drv-dup", "drv-dup"}
	if len(eraser.calls) != len(want) {
		t.Fatalf("Delete llamado %d veces, want %d", len(eraser.calls), len(want))
	}
}
