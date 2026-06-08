// Package domain define las entidades y contratos del núcleo del tracking-service.
// No depende de infraestructura (Redis/Kafka/ClickHouse): solo tipos puros.
package domain

import (
	"errors"
	"time"
)

// Point es una coordenada geográfica (WGS84).
type Point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// ErrInvalidPing indica un ping GPS mal formado.
var ErrInvalidPing = errors.New("ping GPS inválido")

// Ping es un reporte de posición de un conductor recibido por MQTT (1 Hz).
type Ping struct {
	DriverID   string    `json:"driverId"`
	TripID     string    `json:"tripId,omitempty"`
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	Speed      float64   `json:"speed"`    // m/s
	Heading    float64   `json:"heading"`  // grados [0,360)
	Accuracy   float64   `json:"accuracy"` // metros
	RecordedAt time.Time `json:"recordedAt"`
}

// Point devuelve la coordenada del ping.
func (p Ping) Point() Point { return Point{Lat: p.Lat, Lon: p.Lon} }

// Validate verifica que el ping tenga un driver y coordenadas plausibles.
func (p Ping) Validate() error {
	if p.DriverID == "" {
		return ErrInvalidPing
	}
	if p.Lat < -90 || p.Lat > 90 || p.Lon < -180 || p.Lon > 180 {
		return ErrInvalidPing
	}
	return nil
}

// PresenceStatus describe el estado operativo de un conductor.
type PresenceStatus string

const (
	StatusAvailable PresenceStatus = "available"
	StatusBusy      PresenceStatus = "busy"
	StatusOffline   PresenceStatus = "offline"
)
