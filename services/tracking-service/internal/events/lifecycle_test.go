package events

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"testing"
)

// fakeStatusWriter registra SetBusy/Clear para verificar el handler del LifecycleConsumer.
type fakeStatusWriter struct {
	busy    []string // driverIDs marcados busy, en orden
	cleared []string // driverIDs liberados, en orden
	failErr error    // si != nil, ambos métodos fallan
}

func (f *fakeStatusWriter) SetBusy(_ context.Context, driverID string) error {
	if f.failErr != nil {
		return f.failErr
	}
	f.busy = append(f.busy, driverID)
	return nil
}

func (f *fakeStatusWriter) Clear(_ context.Context, driverID string) error {
	if f.failErr != nil {
		return f.failErr
	}
	f.cleared = append(f.cleared, driverID)
	return nil
}

func newTestLifecycle(status DriverStatus) *LifecycleConsumer {
	return &LifecycleConsumer{
		status: status,
		log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestLifecycleConsumerHandle(t *testing.T) {
	tests := []struct {
		name        string
		value       func(t *testing.T) []byte
		wantBusy    []string
		wantCleared []string
		wantErr     bool
	}{
		{
			name: "trip.assigned con driverId → busy",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventTripAssigned, TripAssigned{TripID: "t1", DriverID: "d1", VehicleID: "v1"})
			},
			wantBusy: []string{"d1"},
		},
		{
			name: "trip.completed con driverId → libera",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventTripCompleted, TripCompleted{TripID: "t1", DriverID: "d1"})
			},
			wantCleared: []string{"d1"},
		},
		{
			name: "trip.cancelled con driverId → libera",
			value: func(t *testing.T) []byte {
				return envBytes(t, EventTripCancelled, TripCancelled{TripID: "t1", DriverID: "d1"})
			},
			wantCleared: []string{"d1"},
		},
		{
			name:  "trip.completed SIN driverId → no-op (viaje sin conductor)",
			value: func(t *testing.T) []byte { return envBytes(t, EventTripCompleted, TripCompleted{TripID: "t1"}) },
		},
		{
			name:  "trip.assigned SIN driverId → no-op",
			value: func(t *testing.T) []byte { return envBytes(t, EventTripAssigned, TripAssigned{TripID: "t1"}) },
		},
		{
			name:  "otro evento del topic trip → ignorado",
			value: func(t *testing.T) []byte { return envBytes(t, "trip.requested", map[string]any{"tripId": "t1"}) },
		},
		{
			name:  "envelope malformado → ignorado sin error (commit, no bloquea la partición)",
			value: func(t *testing.T) []byte { return []byte("{ no es json") },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeStatusWriter{}
			c := newTestLifecycle(f)
			err := c.handle(context.Background(), tt.value(t))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(f.busy, tt.wantBusy) {
				t.Errorf("busy = %v, want %v", f.busy, tt.wantBusy)
			}
			if !reflect.DeepEqual(f.cleared, tt.wantCleared) {
				t.Errorf("cleared = %v, want %v", f.cleared, tt.wantCleared)
			}
		})
	}
}

// TestLifecycleConsumerRetriesOnStatusFailure: si el store de status falla, handle devuelve error → el
// consumer NO commitea y Kafka reentrega (al revés que un payload inválido, que se descarta sin error).
func TestLifecycleConsumerRetriesOnStatusFailure(t *testing.T) {
	f := &fakeStatusWriter{failErr: errors.New("redis caído")}
	c := newTestLifecycle(f)
	err := c.handle(context.Background(), envBytes(t, EventTripAssigned, TripAssigned{TripID: "t1", DriverID: "d1"}))
	if err == nil {
		t.Fatal("esperaba error (para que Kafka reintente), got nil")
	}
}
