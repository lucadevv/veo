package api

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// tripDriverKeyPrefix mapea viaje → conductor. trip-service escribe esta key
// (trip:driver:{tripId}) al asignar/aceptar; tracking la lee para el fan-out.
const tripDriverKeyPrefix = "trip:driver:"

// RedisTripResolver resuelve el conductor de un viaje desde Redis.
type RedisTripResolver struct {
	rdb redis.Cmdable
}

// NewRedisTripResolver crea un resolver basado en Redis.
func NewRedisTripResolver(rdb redis.Cmdable) *RedisTripResolver {
	return &RedisTripResolver{rdb: rdb}
}

// DriverForTrip devuelve el driverId asociado a un viaje, o "" si no existe.
func (r *RedisTripResolver) DriverForTrip(ctx context.Context, tripID string) (string, error) {
	val, err := r.rdb.Get(ctx, tripDriverKeyPrefix+tripID).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("api: resolver driver del viaje %s: %w", tripID, err)
	}
	return val, nil
}
