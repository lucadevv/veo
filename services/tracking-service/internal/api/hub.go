package api

import (
	"sync"
	"time"

	"github.com/veo/tracking-service/internal/domain"
)

// LocationUpdate es el mensaje que se reenvía a los suscriptores del tracking.
type LocationUpdate struct {
	DriverID string       `json:"driverId"`
	Point    domain.Point `json:"point"`
	H3       string       `json:"h3"`
	Speed    float64      `json:"speed"`
	Heading  float64      `json:"heading"`
	At       time.Time    `json:"at"`
}

// subscriber es un canal de entrega con buffer pequeño (drop-oldest si se llena).
type subscriber struct {
	driverID string
	ch       chan LocationUpdate
}

// Hub realiza fan-out de actualizaciones de ubicación por driverId a los suscriptores.
type Hub struct {
	mu      sync.RWMutex
	subs    map[string]map[*subscriber]struct{}
	onCount func(int) // callback para métrica de suscriptores
	total   int
}

// NewHub crea un hub de fan-out. onCount (opcional) recibe el total de suscriptores.
func NewHub(onCount func(int)) *Hub {
	return &Hub{
		subs:    make(map[string]map[*subscriber]struct{}),
		onCount: onCount,
	}
}

// Subscribe registra interés en un conductor y devuelve el canal y la función de baja.
func (h *Hub) Subscribe(driverID string) (<-chan LocationUpdate, func()) {
	s := &subscriber{driverID: driverID, ch: make(chan LocationUpdate, 16)}
	h.mu.Lock()
	set, ok := h.subs[driverID]
	if !ok {
		set = make(map[*subscriber]struct{})
		h.subs[driverID] = set
	}
	set[s] = struct{}{}
	h.total++
	total := h.total
	h.mu.Unlock()
	if h.onCount != nil {
		h.onCount(total)
	}

	unsubscribe := func() {
		h.mu.Lock()
		if set, ok := h.subs[driverID]; ok {
			if _, ok := set[s]; ok {
				delete(set, s)
				close(s.ch)
				h.total--
				if len(set) == 0 {
					delete(h.subs, driverID)
				}
			}
		}
		total := h.total
		h.mu.Unlock()
		if h.onCount != nil {
			h.onCount(total)
		}
	}
	return s.ch, unsubscribe
}

// Publish reenvía una actualización a los suscriptores del conductor (no bloqueante).
func (h *Hub) Publish(u LocationUpdate) {
	h.mu.RLock()
	set := h.subs[u.DriverID]
	subs := make([]*subscriber, 0, len(set))
	for s := range set {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, s := range subs {
		select {
		case s.ch <- u:
		default:
			// Suscriptor lento: descartamos para no bloquear la ingesta.
		}
	}
}
