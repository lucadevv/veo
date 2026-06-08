package ingest

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/veo/tracking-service/internal/api"
	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/events"
	"github.com/veo/tracking-service/internal/geo"
	"github.com/veo/tracking-service/internal/geofence"
	"github.com/veo/tracking-service/internal/history"
	"github.com/veo/tracking-service/internal/obs"
)

type fakePresence struct{ res int }

func (f fakePresence) Update(_ context.Context, p domain.Ping, _ domain.PresenceStatus) (string, error) {
	return geo.Cell(p.Point(), f.res)
}

type fakeHistory struct {
	mu   sync.Mutex
	rows []history.Record
}

func (f *fakeHistory) Insert(r history.Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, r)
	return nil
}
func (f *fakeHistory) Delete(context.Context, string) error { return nil }
func (f *fakeHistory) Ping(context.Context) error           { return nil }
func (f *fakeHistory) Close() error                         { return nil }

type captured struct {
	env events.EventEnvelope
	key string
}

type fakePublisher struct {
	mu   sync.Mutex
	sent []captured
}

func (f *fakePublisher) Publish(_ context.Context, env events.EventEnvelope, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, captured{env, key})
	return nil
}
func (f *fakePublisher) Close() error { return nil }
func (f *fakePublisher) byType(t string) []captured {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []captured
	for _, c := range f.sent {
		if c.env.EventType == t {
			out = append(out, c)
		}
	}
	return out
}

type fakeHub struct {
	mu      sync.Mutex
	updates []api.LocationUpdate
}

func (f *fakeHub) Publish(u api.LocationUpdate) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, u)
}

func newPipeline(t *testing.T, publishEvery time.Duration) (*Pipeline, *fakeHistory, *fakePublisher, *fakeHub) {
	t.Helper()
	limaCell, err := geo.Cell(domain.Point{Lat: -12.0464, Lon: -77.0428}, 9)
	if err != nil {
		t.Fatal(err)
	}
	det, err := geofence.NewDetector([]geofence.Zone{
		{ID: "centro-lima", H3Cells: []string{limaCell}, H3Resolution: 9},
	})
	if err != nil {
		t.Fatal(err)
	}
	hist := &fakeHistory{}
	pub := &fakePublisher{}
	hub := &fakeHub{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := NewPipeline(PipelineDeps{
		Presence:     fakePresence{res: 9},
		Geo:          det,
		History:      hist,
		Publisher:    pub,
		Hub:          hub,
		Metrics:      obs.NewMetrics(prometheus.NewRegistry()),
		Logger:       log,
		PublishEvery: publishEvery,
	})
	return p, hist, pub, hub
}

func TestPipelineEmitsLocationAndPersists(t *testing.T) {
	p, hist, pub, hub := newPipeline(t, 0)
	ping := domain.Ping{DriverID: "drv-1", Lat: -12.0464, Lon: -77.0428, Speed: 8, Heading: 90, RecordedAt: time.Now()}

	if err := p.Process(context.Background(), ping); err != nil {
		t.Fatalf("Process: %v", err)
	}

	if len(hist.rows) != 1 {
		t.Fatalf("se esperaba 1 fila histórica, got %d", len(hist.rows))
	}
	loc := pub.byType(events.EventDriverLocationUpdated)
	if len(loc) != 1 {
		t.Fatalf("se esperaba 1 location_updated, got %d", len(loc))
	}
	if loc[0].key != "drv-1" {
		t.Errorf("key Kafka = %q, want drv-1", loc[0].key)
	}
	if len(hub.updates) != 1 {
		t.Fatalf("se esperaba 1 fan-out, got %d", len(hub.updates))
	}
}

func TestPipelineEmitsEnteredZone(t *testing.T) {
	p, _, pub, _ := newPipeline(t, 0)
	ping := domain.Ping{DriverID: "drv-1", Lat: -12.0464, Lon: -77.0428, RecordedAt: time.Now()}

	if err := p.Process(context.Background(), ping); err != nil {
		t.Fatal(err)
	}
	entered := pub.byType(events.EventDriverEnteredZone)
	if len(entered) != 1 {
		t.Fatalf("se esperaba 1 entered_zone, got %d", len(entered))
	}
	payload, ok := entered[0].env.Payload.(events.DriverEnteredZone)
	if !ok {
		t.Fatalf("payload con tipo inesperado: %T", entered[0].env.Payload)
	}
	if payload.ZoneID != "centro-lima" {
		t.Errorf("zoneId = %q, want centro-lima", payload.ZoneID)
	}
}

func TestPipelineInvalidPingDropped(t *testing.T) {
	p, hist, pub, _ := newPipeline(t, 0)
	if err := p.Process(context.Background(), domain.Ping{DriverID: ""}); err != nil {
		t.Fatal(err)
	}
	if len(hist.rows) != 0 || len(pub.sent) != 0 {
		t.Fatal("un ping inválido no debe persistirse ni publicarse")
	}
}

func TestPipelineThrottlesLocation(t *testing.T) {
	p, _, pub, _ := newPipeline(t, time.Hour)
	ping := domain.Ping{DriverID: "drv-1", Lat: -12.0464, Lon: -77.0428, RecordedAt: time.Now()}

	for i := 0; i < 5; i++ {
		if err := p.Process(context.Background(), ping); err != nil {
			t.Fatal(err)
		}
	}
	loc := pub.byType(events.EventDriverLocationUpdated)
	if len(loc) != 1 {
		t.Fatalf("con throttling de 1h se esperaba 1 location_updated, got %d", len(loc))
	}
}
