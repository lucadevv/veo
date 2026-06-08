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

type fakePresence struct {
	res        int
	lastStatus domain.PresenceStatus // último status recibido (para verificar E1)
}

func (f *fakePresence) Update(_ context.Context, p domain.Ping, status domain.PresenceStatus) (string, error) {
	f.lastStatus = status
	return geo.Cell(p.Point(), f.res)
}

// fakeStatus devuelve un status operativo fijo (default available).
type fakeStatus struct {
	status domain.PresenceStatus
	err    error
}

func (f fakeStatus) Get(context.Context, string) (domain.PresenceStatus, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.status, nil
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

// fakeGeo registra las llamadas a Forget (para verificar el reaper) y no detecta transiciones.
type fakeGeo struct {
	mu        sync.Mutex
	forgotten []string
}

func (f *fakeGeo) Evaluate(string, domain.Point) (geofence.Transition, error) {
	return geofence.Transition{}, nil
}
func (f *fakeGeo) Forget(driverID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgotten = append(f.forgotten, driverID)
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
		Presence:     &fakePresence{res: 9},
		Status:       fakeStatus{status: domain.StatusAvailable},
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

// TestPipelineUsesRealDriverStatus verifica E1: el status que la pipeline pasa a la presencia viene del
// StatusReader (ciclo de vida del viaje), no hardcodeado. Un conductor en viaje → busy (fuera del hot index).
func TestPipelineUsesRealDriverStatus(t *testing.T) {
	det, err := geofence.NewDetector(nil)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ping := domain.Ping{DriverID: "drv-1", Lat: -12.0464, Lon: -77.0428, RecordedAt: time.Now()}

	tests := []struct {
		name   string
		status fakeStatus
		want   domain.PresenceStatus
	}{
		{"conductor en viaje → busy", fakeStatus{status: domain.StatusBusy}, domain.StatusBusy},
		{"sin viaje → available", fakeStatus{status: domain.StatusAvailable}, domain.StatusAvailable},
		// Degradación honesta: si el store de status falla, la pipeline asume available (no vacía el pool).
		{"store caído → available (degradación)", fakeStatus{err: context.DeadlineExceeded}, domain.StatusAvailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pres := &fakePresence{res: 9}
			p := NewPipeline(PipelineDeps{
				Presence: pres, Status: tt.status, Geo: det, History: &fakeHistory{},
				Publisher: &fakePublisher{}, Hub: &fakeHub{},
				Metrics: obs.NewMetrics(prometheus.NewRegistry()), Logger: log,
			})
			if err := p.Process(context.Background(), ping); err != nil {
				t.Fatalf("Process: %v", err)
			}
			if pres.lastStatus != tt.want {
				t.Errorf("status pasado a presence = %q, want %q", pres.lastStatus, tt.want)
			}
		})
	}
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

// TestPipelinePublishesZoneExitAndLeftArea verifica Lote 2: antes el exit de zona y la salida de Lima se
// detectaban pero NO se publicaban. Ahora emiten driver.exited_zone y driver.left_operational_area.
func TestPipelinePublishesZoneExitAndLeftArea(t *testing.T) {
	p, _, pub, _ := newPipeline(t, 0)
	ctx := context.Background()
	driver := "drv-1"
	now := time.Now()
	inCentro := domain.Ping{DriverID: driver, Lat: -12.0464, Lon: -77.0428, RecordedAt: now} // celda centro-lima
	otherInLima := domain.Ping{DriverID: driver, Lat: -12.20, Lon: -76.95, RecordedAt: now}  // otra celda, sigue en Lima
	outsideLima := domain.Ping{DriverID: driver, Lat: -13.5, Lon: -76.0, RecordedAt: now}    // Ica (fuera del bbox)

	// Entra a centro-lima → entered_zone, sin salidas todavía.
	if err := p.Process(ctx, inCentro); err != nil {
		t.Fatal(err)
	}
	if got := len(pub.byType(events.EventDriverExitedZone)); got != 0 {
		t.Fatalf("no debía haber exited_zone aún, got %d", got)
	}

	// Sale de centro-lima (pero sigue en Lima) → exited_zone, sin left_operational_area.
	if err := p.Process(ctx, otherInLima); err != nil {
		t.Fatal(err)
	}
	exited := pub.byType(events.EventDriverExitedZone)
	if len(exited) != 1 {
		t.Fatalf("se esperaba 1 exited_zone, got %d", len(exited))
	}
	if pay, ok := exited[0].env.Payload.(events.DriverExitedZone); !ok || pay.ZoneID != "centro-lima" {
		t.Fatalf("exited_zone payload inesperado: %+v", exited[0].env.Payload)
	}
	if got := len(pub.byType(events.EventDriverLeftArea)); got != 0 {
		t.Fatalf("no debía salir de Lima todavía, got %d left_area", got)
	}

	// Sale de Lima Metropolitana → left_operational_area.
	if err := p.Process(ctx, outsideLima); err != nil {
		t.Fatal(err)
	}
	if got := len(pub.byType(events.EventDriverLeftArea)); got != 1 {
		t.Fatalf("se esperaba 1 left_operational_area, got %d", got)
	}
}

// TestPipelineReapEvictsStaleDrivers verifica Lote 3: el estado en memoria (lastSeen/lastPublish +
// geofence) de un conductor inactivo se evicta; el activo se mantiene. Sin esto, los maps crecían sin cota.
func TestPipelineReapEvictsStaleDrivers(t *testing.T) {
	geo := &fakeGeo{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := NewPipeline(PipelineDeps{
		Presence: &fakePresence{res: 9}, Status: fakeStatus{status: domain.StatusAvailable}, Geo: geo,
		History: &fakeHistory{}, Publisher: &fakePublisher{}, Hub: &fakeHub{},
		Metrics: obs.NewMetrics(prometheus.NewRegistry()), Logger: log,
		PublishEvery: time.Hour, // para que shouldPublish pueble lastPublish
	})
	ctx := context.Background()
	pingAt := func(id string) domain.Ping {
		return domain.Ping{DriverID: id, Lat: -12.0464, Lon: -77.0428, RecordedAt: time.Now()}
	}
	if err := p.Process(ctx, pingAt("fresh")); err != nil {
		t.Fatal(err)
	}
	if err := p.Process(ctx, pingAt("stale")); err != nil {
		t.Fatal(err)
	}

	// Envejecemos el lastSeen del "stale" (sin dormir el test).
	p.mu.Lock()
	p.lastSeen["stale"] = time.Now().Add(-time.Hour)
	p.mu.Unlock()

	if n := p.Reap(5 * time.Minute); n != 1 {
		t.Fatalf("Reap evictó %d, want 1", n)
	}
	if len(geo.forgotten) != 1 || geo.forgotten[0] != "stale" {
		t.Fatalf("geo.Forget = %v, want [stale]", geo.forgotten)
	}

	p.mu.Lock()
	_, freshSeen := p.lastSeen["fresh"]
	_, staleSeen := p.lastSeen["stale"]
	_, stalePub := p.lastPublish["stale"]
	p.mu.Unlock()
	if !freshSeen {
		t.Error("el conductor activo NO debía evictarse")
	}
	if staleSeen || stalePub {
		t.Error("el conductor inactivo debía evictarse de lastSeen y lastPublish")
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
