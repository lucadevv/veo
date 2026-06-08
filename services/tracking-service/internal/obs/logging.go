package obs

import (
	"log/slog"
	"os"
	"strings"
)

// NewLogger crea un slog.Logger JSON con el nivel indicado y el nombre de servicio.
func NewLogger(level, service string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(level)})
	return slog.New(h).With(slog.String("service", service))
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// RedactDriverID ofusca un identificador de conductor para logs (PII): conserva
// el prefijo y enmascara el resto. No reversible.
func RedactDriverID(id string) string {
	if id == "" {
		return ""
	}
	if len(id) <= 8 {
		return id[:1] + "***"
	}
	return id[:8] + "***"
}

// CoarseGeo redondea coordenadas a ~1km para evitar loguear ubicación exacta (PII).
func CoarseGeo(lat, lon float64) (float64, float64) {
	round := func(v float64) float64 {
		return float64(int(v*100)) / 100 // 2 decimales ≈ 1.1 km
	}
	return round(lat), round(lon)
}
