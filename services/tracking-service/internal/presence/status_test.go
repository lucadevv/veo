package presence

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/veo/tracking-service/internal/domain"
)

func newStatusStore(t *testing.T, busyTTL time.Duration) (*StatusStore, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewStatusStore(rdb, busyTTL), mr
}

func TestStatusStoreLifecycle(t *testing.T) {
	ctx := context.Background()
	s, _ := newStatusStore(t, time.Hour)

	// Por defecto (sin viaje activo) → disponible.
	if got, err := s.Get(ctx, "d1"); err != nil || got != domain.StatusAvailable {
		t.Fatalf("default Get = %q, %v; want available, nil", got, err)
	}

	// trip.assigned → busy (fuera del hot index de dispatch).
	if err := s.SetBusy(ctx, "d1"); err != nil {
		t.Fatalf("SetBusy: %v", err)
	}
	if got, _ := s.Get(ctx, "d1"); got != domain.StatusBusy {
		t.Fatalf("tras SetBusy Get = %q; want busy", got)
	}

	// trip.completed → liberar → vuelve a disponible.
	if err := s.Clear(ctx, "d1"); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got, _ := s.Get(ctx, "d1"); got != domain.StatusAvailable {
		t.Fatalf("tras Clear Get = %q; want available", got)
	}
}

// TestStatusStoreBusyTTLExpires: la red de seguridad. Si se pierde el trip.completed, el "busy" expira
// solo y el conductor vuelve a estar disponible (no queda fuera del pool para siempre).
func TestStatusStoreBusyTTLExpires(t *testing.T) {
	ctx := context.Background()
	s, mr := newStatusStore(t, 30*time.Minute)

	if err := s.SetBusy(ctx, "d1"); err != nil {
		t.Fatalf("SetBusy: %v", err)
	}
	if got, _ := s.Get(ctx, "d1"); got != domain.StatusBusy {
		t.Fatalf("Get = %q; want busy", got)
	}

	mr.FastForward(31 * time.Minute) // pasó el TTL sin un trip.completed

	if got, _ := s.Get(ctx, "d1"); got != domain.StatusAvailable {
		t.Fatalf("tras expirar el TTL Get = %q; want available", got)
	}
}
