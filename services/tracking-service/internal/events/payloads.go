package events

import "github.com/veo/tracking-service/internal/domain"

// Tipos de evento que publica tracking-service.
const (
	EventDriverLocationUpdated = "driver.location_updated"
	EventDriverEnteredZone     = "driver.entered_zone"
)

// Tipos de evento que consume tracking-service.
const (
	// EventUserDeleted lo emite identity-service tras la gracia de borrado (derecho al
	// olvido, Ley 29733). Su topic es "user" (dominio antes del punto).
	EventUserDeleted = "user.deleted"
)

// UserDeleted es el payload de user.deleted.
// Forma JSON: {userId, driverId?, at}. driverId presente solo si el usuario tenía
// perfil de conductor; el histórico GPS es exclusivo de conductores.
type UserDeleted struct {
	UserID   string `json:"userId"`
	DriverID string `json:"driverId,omitempty"`
	At       string `json:"at"` // ISO-8601
}

// DriverLocationUpdated es el payload de driver.location_updated.
// Forma JSON: {driverId, point:{lat,lon}, h3, at}.
type DriverLocationUpdated struct {
	DriverID string       `json:"driverId"`
	Point    domain.Point `json:"point"`
	H3       string       `json:"h3"`
	At       string       `json:"at"` // ISO-8601
}

// DriverEnteredZone es el payload de driver.entered_zone.
// Forma JSON: {driverId, zoneId, at}.
type DriverEnteredZone struct {
	DriverID string `json:"driverId"`
	ZoneID   string `json:"zoneId"`
	At       string `json:"at"` // ISO-8601
}
