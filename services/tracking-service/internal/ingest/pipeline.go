// Package ingest orquesta la ingesta de pings GPS: presencia, geofencing,
// histórico, publicación de eventos y fan-out a suscriptores.
package ingest

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/veo/tracking-service/internal/api"
	"github.com/veo/tracking-service/internal/config"
	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/events"
	"github.com/veo/tracking-service/internal/geofence"
	"github.com/veo/tracking-service/internal/history"
	"github.com/veo/tracking-service/internal/obs"
)

// PresenceUpdater actualiza la presencia y devuelve la celda H3 del ping.
type PresenceUpdater interface {
	Update(ctx context.Context, p domain.Ping, status domain.PresenceStatus) (string, error)
}

// StatusReader lee el estado operativo (de viaje) del conductor para alimentar la presencia: un
// conductor en viaje es "busy" y NO debe entrar al hot index de dispatch. Lo mantiene el LifecycleConsumer.
type StatusReader interface {
	Get(ctx context.Context, driverID string) (domain.PresenceStatus, error)
}

// GeoEvaluator evalúa transiciones de geofencing para un conductor y olvida su estado al quedar inactivo.
type GeoEvaluator interface {
	Evaluate(driverID string, p domain.Point) (geofence.Transition, error)
	// Forget descarta el estado en memoria de un conductor (zonas/Lima) cuando deja de pingear: sin
	// esto, los maps del detector crecen sin cota (un conductor que se desconecta nunca se limpiaba).
	Forget(driverID string)
}

// Broadcaster reenvía actualizaciones a los suscriptores del tracking.
type Broadcaster interface {
	Publish(u api.LocationUpdate)
}

// Pipeline procesa cada ping de forma idempotente y resiliente (un fallo no aborta el resto).
type Pipeline struct {
	presence  PresenceUpdater
	status    StatusReader
	geo       GeoEvaluator
	history   history.Store
	publisher events.Publisher
	hub       Broadcaster
	metrics   *obs.Metrics
	log       *slog.Logger

	publishEvery time.Duration
	mu           sync.Mutex
	lastPublish  map[string]time.Time // throttle de location_updated por driver
	lastSeen     map[string]time.Time // último ping por driver, para evictar estado de inactivos (Reap)
}

// PipelineDeps agrupa las dependencias del pipeline.
type PipelineDeps struct {
	Presence     PresenceUpdater
	Status       StatusReader
	Geo          GeoEvaluator
	History      history.Store
	Publisher    events.Publisher
	Hub          Broadcaster
	Metrics      *obs.Metrics
	Logger       *slog.Logger
	PublishEvery time.Duration
}

// NewPipeline construye el pipeline de ingesta.
func NewPipeline(d PipelineDeps) *Pipeline {
	return &Pipeline{
		presence:     d.Presence,
		status:       d.Status,
		geo:          d.Geo,
		history:      d.History,
		publisher:    d.Publisher,
		hub:          d.Hub,
		metrics:      d.Metrics,
		log:          d.Logger,
		publishEvery: d.PublishEvery,
		lastPublish:  make(map[string]time.Time),
		lastSeen:     make(map[string]time.Time),
	}
}

// Process ejecuta el flujo completo para un ping. Devuelve error solo en fallos no recuperables.
func (p *Pipeline) Process(ctx context.Context, ping domain.Ping) error {
	start := time.Now()
	defer func() { p.metrics.IngestDuration.Observe(time.Since(start).Seconds()) }()

	if err := ping.Validate(); err != nil {
		p.metrics.PingsInvalidTotal.Inc()
		p.log.Warn("ping inválido descartado", slog.Any("err", err))
		return nil
	}
	p.metrics.PingsTotal.Inc()
	p.markSeen(ping.DriverID)

	serverRecv := time.Now().UTC()
	if ping.RecordedAt.IsZero() {
		ping.RecordedAt = serverRecv
	}

	// 1) Presencia + hot index H3 (alimenta a dispatch-service). El status REAL viene del ciclo de vida
	// del viaje (LifecycleConsumer): un conductor EN VIAJE es "busy" y presence.Update lo deja FUERA del
	// hot index → dispatch no lo matchea (cierra el doble-booking). Degradación honesta: si el store de
	// status falla, asumimos available (el matching sigue; un raro doble-ofrecimiento lo cubre el CAS de
	// asignación del trip-service + el reject del conductor) en vez de vaciar el pool ante un blip de Redis.
	status := domain.StatusAvailable
	if s, serr := p.status.Get(ctx, ping.DriverID); serr != nil {
		p.log.Warn("status: fallo al leer; asumo available",
			slog.String("driver", obs.RedactDriverID(ping.DriverID)), slog.Any("err", serr))
	} else {
		status = s
	}

	cell, err := p.presence.Update(ctx, ping, status)
	if err != nil {
		p.log.Error("presencia: fallo al actualizar", slog.String("driver", obs.RedactDriverID(ping.DriverID)), slog.Any("err", err))
		// Continuamos: la presencia es importante pero el histórico/eventos también.
	}

	// 2) Histórico GPS en ClickHouse.
	if err := p.history.Insert(history.Record{
		DriverID:         ping.DriverID,
		TripID:           ping.TripID,
		Lat:              ping.Lat,
		Lon:              ping.Lon,
		Speed:            ping.Speed,
		Heading:          ping.Heading,
		Accuracy:         ping.Accuracy,
		RecordedAt:       ping.RecordedAt,
		ServerReceivedAt: serverRecv,
	}); err != nil {
		p.metrics.HistoryInsertError.Inc()
		p.log.Warn("histórico: ping no persistido", slog.Any("err", err))
	}

	// 3) Geofencing (zonas + Lima Metropolitana BR-D03).
	transition, err := p.geo.Evaluate(ping.DriverID, ping.Point())
	if err != nil {
		p.log.Error("geofence: fallo al evaluar", slog.Any("err", err))
	} else {
		p.handleGeofence(ctx, ping, transition)
	}

	// 4) Fan-out a suscriptores del tracking (passenger/familia).
	p.hub.Publish(api.LocationUpdate{
		DriverID: ping.DriverID,
		Point:    ping.Point(),
		H3:       cell,
		Speed:    ping.Speed,
		Heading:  ping.Heading,
		At:       ping.RecordedAt,
	})

	// 5) Publicar driver.location_updated (con throttling por conductor).
	if p.shouldPublish(ping.DriverID, start) {
		p.publishLocation(ctx, ping, cell)
	}

	return nil
}

func (p *Pipeline) handleGeofence(ctx context.Context, ping domain.Ping, t geofence.Transition) {
	at := ping.RecordedAt.UTC().Format(time.RFC3339Nano)

	for _, zoneID := range t.Entered {
		p.metrics.GeofenceEntries.WithLabelValues(zoneID).Inc()
		p.publishEvent(ctx, events.EventDriverEnteredZone, ping.DriverID,
			events.DriverEnteredZone{DriverID: ping.DriverID, ZoneID: zoneID, At: at})
	}
	// SIMÉTRICO a las entradas: antes el exit se detectaba pero solo se borraba el estado, sin evento →
	// ningún consumidor sabía que el conductor salió de la zona (gap de auditoría/operación, BR-D03).
	for _, zoneID := range t.Exited {
		p.metrics.GeofenceExits.WithLabelValues(zoneID).Inc()
		p.publishEvent(ctx, events.EventDriverExitedZone, ping.DriverID,
			events.DriverExitedZone{DriverID: ping.DriverID, ZoneID: zoneID, At: at})
	}

	if !t.InLima {
		p.metrics.OutsideLimaTotal.Inc()
		lat, lon := obs.CoarseGeo(ping.Lat, ping.Lon)
		p.log.Warn("conductor fuera de Lima Metropolitana (BR-D03)",
			slog.String("driver", obs.RedactDriverID(ping.DriverID)),
			slog.Float64("lat", lat), slog.Float64("lon", lon),
		)
	}
	// Transición de SALIDA del área operativa (una sola vez al cruzar el borde, no en cada ping de afuera):
	// antes solo se logueaba; ahora es un evento para que dispatch/ops reaccionen.
	if t.LeftLima {
		p.publishEvent(ctx, events.EventDriverLeftArea, ping.DriverID,
			events.DriverLeftArea{DriverID: ping.DriverID, Point: ping.Point(), At: at})
	}
}

func (p *Pipeline) publishLocation(ctx context.Context, ping domain.Ping, cell string) {
	p.publishEvent(ctx, events.EventDriverLocationUpdated, ping.DriverID,
		events.DriverLocationUpdated{
			DriverID: ping.DriverID,
			Point:    ping.Point(),
			H3:       cell,
			At:       ping.RecordedAt.UTC().Format(time.RFC3339Nano),
		})
}

// publishEvent arma el envelope, publica a Kafka (key = entidad raíz) y lleva las métricas, uniforme
// para todos los eventos de dominio del pipeline. La key es el driverId (partición por conductor).
func (p *Pipeline) publishEvent(ctx context.Context, eventType, key string, payload any) {
	env := events.NewEnvelope(events.NewEnvelopeInput{
		EventType: eventType,
		Producer:  config.ProducerName(),
		Payload:   payload,
	})
	if err := p.publisher.Publish(ctx, env, key); err != nil {
		p.metrics.EventsPublishError.Inc()
		p.log.Error("evento no publicado", slog.String("event", eventType), slog.Any("err", err))
		return
	}
	p.metrics.EventsPublished.WithLabelValues(eventType).Inc()
}

// markSeen registra el último ping de un conductor (para que Reap evicte a los inactivos).
func (p *Pipeline) markSeen(driverID string) {
	p.mu.Lock()
	p.lastSeen[driverID] = time.Now()
	p.mu.Unlock()
}

// Reap evicta el estado EN MEMORIA de los conductores que no pingean hace más de `staleAfter`: borra sus
// entradas de los maps lastSeen/lastPublish y olvida su estado de geofence. Sin esto ambos maps crecían
// sin cota (riesgo de OOM con miles de conductores rotando). La presencia Redis ya auto-expira por TTL;
// esto limpia lo que vive en proceso. Devuelve cuántos conductores evictó. Lo invoca el Reaper (ticker).
func (p *Pipeline) Reap(staleAfter time.Duration) int {
	cutoff := time.Now().Add(-staleAfter)
	p.mu.Lock()
	var stale []string
	for id, seen := range p.lastSeen {
		if seen.Before(cutoff) {
			stale = append(stale, id)
		}
	}
	for _, id := range stale {
		delete(p.lastSeen, id)
		delete(p.lastPublish, id)
	}
	p.mu.Unlock()
	// Forget fuera del lock del pipeline: el detector tiene su propio mutex (evita anidar locks).
	for _, id := range stale {
		p.geo.Forget(id)
	}
	return len(stale)
}

// shouldPublish aplica throttling por conductor para no saturar Kafka a 1 Hz × N drivers.
func (p *Pipeline) shouldPublish(driverID string, now time.Time) bool {
	if p.publishEvery <= 0 {
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	last, ok := p.lastPublish[driverID]
	if ok && now.Sub(last) < p.publishEvery {
		return false
	}
	p.lastPublish[driverID] = now
	return true
}
