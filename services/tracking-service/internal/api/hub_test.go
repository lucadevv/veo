package api

import (
	"testing"
	"time"

	"github.com/veo/tracking-service/internal/domain"
)

func TestHubDeliversToSubscriber(t *testing.T) {
	hub := NewHub(nil)
	ch, unsub := hub.Subscribe("drv-1")
	defer unsub()

	hub.Publish(LocationUpdate{DriverID: "drv-1", Point: domain.Point{Lat: -12.0, Lon: -77.0}})

	select {
	case u := <-ch:
		if u.DriverID != "drv-1" {
			t.Fatalf("driverId = %q, want drv-1", u.DriverID)
		}
	case <-time.After(time.Second):
		t.Fatal("no se recibió la actualización")
	}
}

func TestHubIsolatesByDriver(t *testing.T) {
	hub := NewHub(nil)
	ch, unsub := hub.Subscribe("drv-1")
	defer unsub()

	hub.Publish(LocationUpdate{DriverID: "drv-2"})

	select {
	case <-ch:
		t.Fatal("no debería recibir updates de otro conductor")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestHubUnsubscribeStopsDelivery(t *testing.T) {
	hub := NewHub(nil)
	ch, unsub := hub.Subscribe("drv-1")
	unsub()

	if _, open := <-ch; open {
		t.Fatal("el canal debería estar cerrado tras unsubscribe")
	}
}

func TestHubCountCallback(t *testing.T) {
	var count int
	hub := NewHub(func(n int) { count = n })
	_, unsub := hub.Subscribe("drv-1")
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	unsub()
	if count != 0 {
		t.Fatalf("count = %d, want 0 tras unsubscribe", count)
	}
}
