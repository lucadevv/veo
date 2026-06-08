package ingest

import (
	"context"
	"log/slog"
	"time"
)

// Reaper evicta periódicamente el estado EN MEMORIA de conductores inactivos (anti-leak): cada tick llama
// a Pipeline.Reap, que limpia los maps lastSeen/lastPublish y olvida el geofence de quien no pingea hace
// más de `staleAfter`. Patrón ticker + contexto: corre en una goroutine y termina al cancelarse ctx.
type Reaper struct {
	pipeline   *Pipeline
	interval   time.Duration
	staleAfter time.Duration
	log        *slog.Logger
}

// NewReaper crea (sin arrancar) el reaper.
func NewReaper(p *Pipeline, interval, staleAfter time.Duration, log *slog.Logger) *Reaper {
	if log == nil {
		log = slog.Default()
	}
	return &Reaper{pipeline: p, interval: interval, staleAfter: staleAfter, log: log}
}

// Start arranca el barrido en una goroutine; termina al cancelarse ctx.
func (r *Reaper) Start(ctx context.Context) {
	go r.run(ctx)
}

func (r *Reaper) run(ctx context.Context) {
	t := time.NewTicker(r.interval)
	defer t.Stop()
	r.log.Info("reaper de estado en memoria activo",
		slog.Duration("interval", r.interval), slog.Duration("stale_after", r.staleAfter))
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n := r.pipeline.Reap(r.staleAfter); n > 0 {
				r.log.Debug("reaper: estado en memoria evictado", slog.Int("drivers", n))
			}
		}
	}
}
