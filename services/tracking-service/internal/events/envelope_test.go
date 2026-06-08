package events

import (
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/veo/tracking-service/internal/domain"
)

var uuidV7Re = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestUUIDv7Format(t *testing.T) {
	id := UUIDv7(time.Now())
	if !uuidV7Re.MatchString(id) {
		t.Fatalf("UUIDv7 con formato inválido: %q", id)
	}
}

func TestUUIDv7TimeOrdered(t *testing.T) {
	a := UUIDv7(time.UnixMilli(1_700_000_000_000))
	b := UUIDv7(time.UnixMilli(1_700_000_001_000))
	if a >= b {
		t.Fatalf("UUIDv7 debe ser ordenable por tiempo: %q !< %q", a, b)
	}
}

func TestTopicForEvent(t *testing.T) {
	cases := map[string]string{
		"driver.location_updated": "driver",
		"driver.entered_zone":     "driver",
		"trip.completed":          "trip",
		"sintopico":               "misc",
	}
	for in, want := range cases {
		if got := TopicForEvent(in); got != want {
			t.Errorf("TopicForEvent(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEnvelopeJSONContract verifica que el JSON publicado matchee @veo/events.
func TestEnvelopeJSONContract(t *testing.T) {
	env := NewEnvelope(NewEnvelopeInput{
		EventType: EventDriverLocationUpdated,
		Producer:  "tracking-service",
		Payload: DriverLocationUpdated{
			DriverID: "drv-1",
			Point:    domain.Point{Lat: -12.06, Lon: -77.04},
			H3:       "89283082837ffff",
			At:       "2026-05-28T23:00:00Z",
		},
	})

	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Campos requeridos del envelope.
	for _, k := range []string{"eventId", "eventType", "occurredAt", "producer", "schemaVersion", "payload"} {
		if _, ok := decoded[k]; !ok {
			t.Errorf("falta campo requerido %q en el envelope", k)
		}
	}
	// Campos opcionales vacíos deben omitirse (traceId, dedupKey).
	if _, ok := decoded["traceId"]; ok {
		t.Error("traceId vacío no debe serializarse")
	}
	if _, ok := decoded["dedupKey"]; ok {
		t.Error("dedupKey vacío no debe serializarse")
	}

	if env.SchemaVersion != 1 {
		t.Errorf("schemaVersion = %d, want 1", env.SchemaVersion)
	}
	if env.Producer != "tracking-service" {
		t.Errorf("producer = %q, want tracking-service", env.Producer)
	}
	if !uuidV7Re.MatchString(env.EventID) {
		t.Errorf("eventId no es UUIDv7: %q", env.EventID)
	}
	if _, err := time.Parse(time.RFC3339Nano, env.OccurredAt); err != nil {
		t.Errorf("occurredAt no es ISO-8601: %q", env.OccurredAt)
	}
}

// TestLocationPayloadShape verifica la forma exacta del payload {driverId, point:{lat,lon}, h3, at}.
func TestLocationPayloadShape(t *testing.T) {
	p := DriverLocationUpdated{
		DriverID: "drv-1",
		Point:    domain.Point{Lat: -12.06, Lon: -77.04},
		H3:       "89283082837ffff",
		At:       "2026-05-28T23:00:00Z",
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"driverId", "point", "h3", "at"} {
		if _, ok := m[k]; !ok {
			t.Errorf("payload location: falta %q", k)
		}
	}
	var point map[string]float64
	if err := json.Unmarshal(m["point"], &point); err != nil {
		t.Fatalf("point unmarshal: %v", err)
	}
	if _, ok := point["lat"]; !ok {
		t.Error("point.lat ausente")
	}
	if _, ok := point["lon"]; !ok {
		t.Error("point.lon ausente")
	}
}

func TestEnteredZonePayloadShape(t *testing.T) {
	raw, err := json.Marshal(DriverEnteredZone{DriverID: "d1", ZoneID: "z1", At: "2026-05-28T23:00:00Z"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"driverId", "zoneId", "at"} {
		if _, ok := m[k]; !ok {
			t.Errorf("payload entered_zone: falta %q", k)
		}
	}
}
