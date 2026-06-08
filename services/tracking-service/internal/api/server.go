package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// HealthCheck es una verificación nombrada de readiness.
type HealthCheck func(ctx context.Context) error

// TripDriverResolver resuelve el conductor asignado a un viaje (contrato con trip-service).
type TripDriverResolver interface {
	DriverForTrip(ctx context.Context, tripID string) (string, error)
}

// ServerDeps son las dependencias del servidor HTTP.
type ServerDeps struct {
	Addr     string
	Logger   *slog.Logger
	Registry *prometheus.Registry
	Hub      *Hub
	Resolver TripDriverResolver
	Checks   map[string]HealthCheck
}

// Server expone health, readiness, métricas y el fan-out de tracking.
type Server struct {
	deps ServerDeps
	http *http.Server
}

// NewServer construye el servidor con sus rutas.
func NewServer(deps ServerDeps) *Server {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)

	s := &Server{deps: deps}

	r.Get("/health", s.handleLive)
	r.Get("/health/ready", s.handleReady)
	r.Handle("/metrics", promhttp.HandlerFor(deps.Registry, promhttp.HandlerOpts{}))
	r.Get("/tracking/{tripId}", s.handleTrackingSSE)

	s.http = &http.Server{
		Addr:              deps.Addr,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s
}

// Start arranca el servidor (bloqueante hasta error o cierre).
func (s *Server) Start() error {
	if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("api: listen: %w", err)
	}
	return nil
}

// Shutdown apaga el servidor con timeout.
func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.http.Shutdown(ctx); err != nil {
		return fmt.Errorf("api: shutdown: %w", err)
	}
	return nil
}

func (s *Server) handleLive(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	results := make(map[string]string, len(s.deps.Checks))
	ready := true
	for name, check := range s.deps.Checks {
		if err := check(ctx); err != nil {
			ready = false
			results[name] = "down"
			s.deps.Logger.Warn("readiness check fallida", slog.String("dep", name), slog.Any("err", err))
		} else {
			results[name] = "up"
		}
	}

	status := http.StatusOK
	overall := "ready"
	if !ready {
		status = http.StatusServiceUnavailable
		overall = "not_ready"
	}
	writeJSON(w, status, map[string]any{"status": overall, "checks": results})
}

func (s *Server) handleTrackingSSE(w http.ResponseWriter, r *http.Request) {
	tripID := chi.URLParam(r, "tripId")
	if tripID == "" {
		http.Error(w, "tripId requerido", http.StatusBadRequest)
		return
	}

	driverID := r.URL.Query().Get("driverId")
	if driverID == "" && s.deps.Resolver != nil {
		resolved, err := s.deps.Resolver.DriverForTrip(r.Context(), tripID)
		if err != nil {
			s.deps.Logger.Warn("no se pudo resolver driver del viaje", slog.String("tripId", tripID), slog.Any("err", err))
		}
		driverID = resolved
	}
	if driverID == "" {
		http.Error(w, "no hay conductor asociado a este viaje", http.StatusNotFound)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming no soportado", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	updates, unsubscribe := s.deps.Hub.Subscribe(driverID)
	defer unsubscribe()

	// Comentario inicial para abrir el stream.
	fmt.Fprintf(w, ": stream abierto para trip %s\n\n", tripID)
	flusher.Flush()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case u, ok := <-updates:
			if !ok {
				return
			}
			data, err := json.Marshal(u)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: location\ndata: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
