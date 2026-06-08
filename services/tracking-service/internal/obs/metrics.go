// Package obs agrupa la observabilidad: métricas Prometheus, logging estructurado
// con redacción de PII y tracing OpenTelemetry.
package obs

import "github.com/prometheus/client_golang/prometheus"

// Metrics agrupa los colectores Prometheus del servicio.
type Metrics struct {
	PingsTotal         prometheus.Counter
	PingsInvalidTotal  prometheus.Counter
	GeofenceEntries    *prometheus.CounterVec
	GeofenceExits      *prometheus.CounterVec
	OutsideLimaTotal   prometheus.Counter
	EventsPublished    *prometheus.CounterVec
	EventsPublishError prometheus.Counter
	HistoryInsertError prometheus.Counter
	StreamSubscribers  prometheus.Gauge
	IngestDuration     prometheus.Histogram
}

// NewMetrics crea y registra los colectores en el registry dado.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		PingsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "tracking", Name: "pings_total",
			Help: "Total de pings GPS procesados.",
		}),
		PingsInvalidTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "tracking", Name: "pings_invalid_total",
			Help: "Total de pings GPS descartados por inválidos.",
		}),
		GeofenceEntries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "tracking", Name: "geofence_entries_total",
			Help: "Entradas de conductores en zonas (por zona).",
		}, []string{"zone"}),
		GeofenceExits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "tracking", Name: "geofence_exits_total",
			Help: "Salidas de conductores de zonas (por zona).",
		}, []string{"zone"}),
		OutsideLimaTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "tracking", Name: "outside_lima_total",
			Help: "Pings recibidos fuera de Lima Metropolitana (BR-D03).",
		}),
		EventsPublished: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "tracking", Name: "events_published_total",
			Help: "Eventos de dominio publicados a Kafka (por tipo).",
		}, []string{"event_type"}),
		EventsPublishError: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "tracking", Name: "events_publish_errors_total",
			Help: "Errores al publicar eventos a Kafka.",
		}),
		HistoryInsertError: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "tracking", Name: "history_insert_errors_total",
			Help: "Errores al persistir pings en ClickHouse.",
		}),
		StreamSubscribers: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "tracking", Name: "stream_subscribers",
			Help: "Suscriptores activos al fan-out de tracking.",
		}),
		IngestDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: "tracking", Name: "ingest_duration_seconds",
			Help:    "Latencia de procesamiento de un ping (ingesta completa).",
			Buckets: prometheus.DefBuckets,
		}),
	}
	reg.MustRegister(
		m.PingsTotal, m.PingsInvalidTotal, m.GeofenceEntries, m.GeofenceExits, m.OutsideLimaTotal,
		m.EventsPublished, m.EventsPublishError, m.HistoryInsertError,
		m.StreamSubscribers, m.IngestDuration,
	)
	return m
}
