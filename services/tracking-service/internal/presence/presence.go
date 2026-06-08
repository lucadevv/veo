// Package presence mantiene la presencia de conductores en Redis:
//   - driver:loc:{id}  → hash {lat,lon,status,speed,heading,h3,updatedAt} con TTL.
//   - h3:available:{cell} → SET de driverIds disponibles por celda H3 (hot index).
//
// dispatch-service consume estas mismas keys para el matching geoespacial.
package presence

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/geo"
)

const (
	locKeyPrefix = "driver:loc:"
	h3KeyPrefix  = "h3:available:"
)

// LocKey devuelve la key Redis del estado de presencia de un conductor.
func LocKey(driverID string) string { return locKeyPrefix + driverID }

// H3Key devuelve la key Redis del SET de disponibles de una celda H3.
func H3Key(cell string) string { return h3KeyPrefix + cell }

// Store gestiona la presencia y el hot index H3 sobre Redis.
type Store struct {
	rdb          redis.Cmdable
	ttl          time.Duration
	h3Resolution int
}

// New crea un Store de presencia.
func New(rdb redis.Cmdable, ttl time.Duration, h3Resolution int) *Store {
	return &Store{rdb: rdb, ttl: ttl, h3Resolution: h3Resolution}
}

// Location es el estado de presencia leído de Redis.
type Location struct {
	DriverID  string
	Lat       float64
	Lon       float64
	Status    domain.PresenceStatus
	Speed     float64
	Heading   float64
	H3        string
	UpdatedAt time.Time
}

// Update escribe la presencia del conductor con TTL y mantiene el hot index H3.
// Devuelve la celda H3 (resolución configurada) calculada para el punto.
func (s *Store) Update(ctx context.Context, p domain.Ping, status domain.PresenceStatus) (string, error) {
	cell, err := geo.Cell(p.Point(), s.h3Resolution)
	if err != nil {
		return "", err
	}

	locKey := LocKey(p.DriverID)
	prevCell, err := s.rdb.HGet(ctx, locKey, "h3").Result()
	if err != nil && err != redis.Nil {
		return "", fmt.Errorf("presence: leer celda previa %s: %w", p.DriverID, err)
	}

	now := time.Now().UTC()
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, locKey, map[string]any{
		"lat":       strconv.FormatFloat(p.Lat, 'f', -1, 64),
		"lon":       strconv.FormatFloat(p.Lon, 'f', -1, 64),
		"status":    string(status),
		"speed":     strconv.FormatFloat(p.Speed, 'f', -1, 64),
		"heading":   strconv.FormatFloat(p.Heading, 'f', -1, 64),
		"h3":        cell,
		"updatedAt": now.Format(time.RFC3339Nano),
	})
	pipe.Expire(ctx, locKey, s.ttl)

	// Mover el conductor entre celdas del hot index.
	if prevCell != "" && prevCell != cell {
		pipe.SRem(ctx, H3Key(prevCell), p.DriverID)
	}
	if status == domain.StatusAvailable {
		pipe.SAdd(ctx, H3Key(cell), p.DriverID)
		pipe.Expire(ctx, H3Key(cell), s.ttl)
	} else {
		// No disponible: fuera del hot index.
		pipe.SRem(ctx, H3Key(cell), p.DriverID)
	}

	if _, err := pipe.Exec(ctx); err != nil {
		return "", fmt.Errorf("presence: actualizar %s: %w", p.DriverID, err)
	}
	return cell, nil
}

// Get lee el estado de presencia actual de un conductor. Devuelve (nil, nil) si expiró.
func (s *Store) Get(ctx context.Context, driverID string) (*Location, error) {
	vals, err := s.rdb.HGetAll(ctx, LocKey(driverID)).Result()
	if err != nil {
		return nil, fmt.Errorf("presence: get %s: %w", driverID, err)
	}
	if len(vals) == 0 {
		return nil, nil
	}
	loc := &Location{DriverID: driverID, Status: domain.PresenceStatus(vals["status"]), H3: vals["h3"]}
	loc.Lat, _ = strconv.ParseFloat(vals["lat"], 64)
	loc.Lon, _ = strconv.ParseFloat(vals["lon"], 64)
	loc.Speed, _ = strconv.ParseFloat(vals["speed"], 64)
	loc.Heading, _ = strconv.ParseFloat(vals["heading"], 64)
	if ts := vals["updatedAt"]; ts != "" {
		loc.UpdatedAt, _ = time.Parse(time.RFC3339Nano, ts)
	}
	return loc, nil
}

// AvailableInCell devuelve los driverIds disponibles en una celda H3 (lo que lee dispatch).
func (s *Store) AvailableInCell(ctx context.Context, cell string) ([]string, error) {
	ids, err := s.rdb.SMembers(ctx, H3Key(cell)).Result()
	if err != nil {
		return nil, fmt.Errorf("presence: SMembers %s: %w", cell, err)
	}
	return ids, nil
}

// Remove saca al conductor de la presencia y del hot index (offline / desconexión).
func (s *Store) Remove(ctx context.Context, driverID string) error {
	cell, err := s.rdb.HGet(ctx, LocKey(driverID), "h3").Result()
	if err != nil && err != redis.Nil {
		return fmt.Errorf("presence: remove get %s: %w", driverID, err)
	}
	pipe := s.rdb.TxPipeline()
	if cell != "" {
		pipe.SRem(ctx, H3Key(cell), driverID)
	}
	pipe.Del(ctx, LocKey(driverID))
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("presence: remove %s: %w", driverID, err)
	}
	return nil
}

// Ping verifica conectividad con Redis (readiness).
func (s *Store) Ping(ctx context.Context) error {
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("presence: redis ping: %w", err)
	}
	return nil
}
