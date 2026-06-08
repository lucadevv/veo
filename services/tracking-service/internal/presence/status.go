package presence

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/veo/tracking-service/internal/domain"
)

const statusKeyPrefix = "driver:trip_status:"

// StatusKey devuelve la key Redis del estado operativo (de viaje) de un conductor.
func StatusKey(driverID string) string { return statusKeyPrefix + driverID }

// StatusStore guarda en Redis el estado operativo del conductor derivado del ciclo de vida del viaje:
// un conductor EN VIAJE está "busy" y NO debe aparecer disponible para el matching de dispatch. Vive en
// Redis (durable + replica-safe; lo escribe el LifecycleConsumer desde cualquier réplica, lo lee la
// pipeline de ingesta en el hot-path). La AUSENCIA de la key = disponible (el estado por defecto).
//
// `busyTTL` es una RED DE SEGURIDAD: si el trip.completed/cancelled se perdiera (Kafka), el conductor no
// queda "busy" para siempre — la marca expira sola. Un trip.completed normal la limpia antes (Clear).
type StatusStore struct {
	rdb     redis.Cmdable
	busyTTL time.Duration
}

// NewStatusStore crea el store del estado de viaje.
func NewStatusStore(rdb redis.Cmdable, busyTTL time.Duration) *StatusStore {
	return &StatusStore{rdb: rdb, busyTTL: busyTTL}
}

// SetBusy marca al conductor como ocupado (en viaje), con TTL de seguridad. Idempotente.
func (s *StatusStore) SetBusy(ctx context.Context, driverID string) error {
	if err := s.rdb.Set(ctx, StatusKey(driverID), string(domain.StatusBusy), s.busyTTL).Err(); err != nil {
		return fmt.Errorf("status: marcar busy %s: %w", driverID, err)
	}
	return nil
}

// Clear libera al conductor (viaje terminado/cancelado): vuelve a disponible (el default). Idempotente.
func (s *StatusStore) Clear(ctx context.Context, driverID string) error {
	if err := s.rdb.Del(ctx, StatusKey(driverID)).Err(); err != nil {
		return fmt.Errorf("status: liberar %s: %w", driverID, err)
	}
	return nil
}

// Get devuelve el estado operativo del conductor: StatusBusy si está marcado, StatusAvailable por
// defecto (sin viaje activo). Lo consulta la pipeline en cada ping para alimentar la presencia.
func (s *StatusStore) Get(ctx context.Context, driverID string) (domain.PresenceStatus, error) {
	v, err := s.rdb.Get(ctx, StatusKey(driverID)).Result()
	if err == redis.Nil {
		return domain.StatusAvailable, nil
	}
	if err != nil {
		return "", fmt.Errorf("status: get %s: %w", driverID, err)
	}
	if v == string(domain.StatusBusy) {
		return domain.StatusBusy, nil
	}
	return domain.StatusAvailable, nil
}
