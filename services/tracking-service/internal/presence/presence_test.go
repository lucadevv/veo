package presence

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/geo"
)

func newTestStore(t *testing.T, ttl time.Duration) (*Store, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return New(rdb, ttl, 9), mr, rdb
}

var lima = domain.Ping{DriverID: "drv-1", Lat: -12.0464, Lon: -77.0428}

func TestPresenceUpdateWritesLocationAndHotIndex(t *testing.T) {
	ctx := context.Background()
	s, _, rdb := newTestStore(t, 60*time.Second)

	cell, err := s.Update(ctx, lima, domain.StatusAvailable)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	loc, err := s.Get(ctx, lima.DriverID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loc == nil {
		t.Fatal("presencia no encontrada tras Update")
	}
	if loc.Status != domain.StatusAvailable {
		t.Errorf("status = %q, want available", loc.Status)
	}
	if loc.H3 != cell {
		t.Errorf("h3 = %q, want %q", loc.H3, cell)
	}

	members, err := rdb.SMembers(ctx, H3Key(cell)).Result()
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0] != lima.DriverID {
		t.Fatalf("hot index = %v, want [%s]", members, lima.DriverID)
	}
}

// TestPresenceTTLExpires es el test clave: tras el TTL, la presencia desaparece.
func TestPresenceTTLExpires(t *testing.T) {
	ctx := context.Background()
	s, mr, rdb := newTestStore(t, 60*time.Second)

	cell, err := s.Update(ctx, lima, domain.StatusAvailable)
	if err != nil {
		t.Fatal(err)
	}

	// Antes del TTL: existe.
	if loc, _ := s.Get(ctx, lima.DriverID); loc == nil {
		t.Fatal("presencia debería existir antes del TTL")
	}
	ttl, err := rdb.TTL(ctx, LocKey(lima.DriverID)).Result()
	if err != nil {
		t.Fatal(err)
	}
	if ttl <= 0 || ttl > 60*time.Second {
		t.Fatalf("TTL fuera de rango: %v", ttl)
	}

	// Avanzamos el reloj 61s: debe expirar.
	mr.FastForward(61 * time.Second)

	loc, err := s.Get(ctx, lima.DriverID)
	if err != nil {
		t.Fatal(err)
	}
	if loc != nil {
		t.Fatal("la presencia debería haber expirado por TTL")
	}
	if mr.Exists(LocKey(lima.DriverID)) {
		t.Fatal("driver:loc debería estar expirado")
	}
	if mr.Exists(H3Key(cell)) {
		t.Fatal("hot index H3 debería estar expirado")
	}
}

func TestPresenceMovesBetweenCells(t *testing.T) {
	ctx := context.Background()
	s, _, rdb := newTestStore(t, 60*time.Second)

	cellA, err := s.Update(ctx, lima, domain.StatusAvailable)
	if err != nil {
		t.Fatal(err)
	}

	far := domain.Ping{DriverID: "drv-1", Lat: -12.20, Lon: -76.90}
	cellB, err := s.Update(ctx, far, domain.StatusAvailable)
	if err != nil {
		t.Fatal(err)
	}
	if cellA == cellB {
		t.Skip("las dos coordenadas cayeron en la misma celda; ajustar fixture")
	}

	if n, _ := rdb.SCard(ctx, H3Key(cellA)).Result(); n != 0 {
		t.Errorf("celda anterior debería quedar vacía, card=%d", n)
	}
	members, _ := rdb.SMembers(ctx, H3Key(cellB)).Result()
	if len(members) != 1 || members[0] != "drv-1" {
		t.Errorf("nueva celda debería contener al driver, got %v", members)
	}
}

func TestPresenceBusyRemovesFromHotIndex(t *testing.T) {
	ctx := context.Background()
	s, _, rdb := newTestStore(t, 60*time.Second)

	cell, _ := s.Update(ctx, lima, domain.StatusAvailable)
	if n, _ := rdb.SCard(ctx, H3Key(cell)).Result(); n != 1 {
		t.Fatalf("disponible debería estar en el índice, card=%d", n)
	}

	if _, err := s.Update(ctx, lima, domain.StatusBusy); err != nil {
		t.Fatal(err)
	}
	if n, _ := rdb.SCard(ctx, H3Key(cell)).Result(); n != 0 {
		t.Fatalf("ocupado no debería estar en el hot index, card=%d", n)
	}
}

func TestPresenceRemove(t *testing.T) {
	ctx := context.Background()
	s, _, rdb := newTestStore(t, 60*time.Second)

	cell, _ := s.Update(ctx, lima, domain.StatusAvailable)
	if err := s.Remove(ctx, lima.DriverID); err != nil {
		t.Fatal(err)
	}
	if loc, _ := s.Get(ctx, lima.DriverID); loc != nil {
		t.Error("presencia debería estar eliminada")
	}
	if n, _ := rdb.SCard(ctx, H3Key(cell)).Result(); n != 0 {
		t.Errorf("hot index debería estar vacío, card=%d", n)
	}
}

// Verificación de coherencia con el cálculo de celdas H3 directo.
func TestUpdateUsesH3Resolution9(t *testing.T) {
	ctx := context.Background()
	s, _, _ := newTestStore(t, 60*time.Second)

	cell, err := s.Update(ctx, lima, domain.StatusAvailable)
	if err != nil {
		t.Fatal(err)
	}
	want, err := geo.Cell(lima.Point(), 9)
	if err != nil {
		t.Fatal(err)
	}
	if cell != want {
		t.Fatalf("celda = %q, want %q", cell, want)
	}
}
