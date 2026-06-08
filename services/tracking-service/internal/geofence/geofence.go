// Package geofence detecta entradas de conductores en zonas definidas y verifica
// la pertenencia a Lima Metropolitana (BR-D03). Soporta polígonos (ray casting)
// y pertenencia por celdas H3.
package geofence

import (
	"fmt"
	"sync"

	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/geo"
)

// BBox es una caja delimitadora geográfica.
type BBox struct {
	MinLat, MaxLat float64
	MinLon, MaxLon float64
}

// Contains indica si el punto cae dentro del bbox (bordes inclusive).
func (b BBox) Contains(p domain.Point) bool {
	return p.Lat >= b.MinLat && p.Lat <= b.MaxLat &&
		p.Lon >= b.MinLon && p.Lon <= b.MaxLon
}

// LimaBBox delimita Lima Metropolitana (BR-D03): lat -12.52..-11.57, lon -77.2..-76.7.
var LimaBBox = BBox{MinLat: -12.52, MaxLat: -11.57, MinLon: -77.2, MaxLon: -76.7}

// Zone es una zona geográfica definida por un polígono y/o un conjunto de celdas H3.
type Zone struct {
	ID           string         `json:"id"`
	Polygon      []domain.Point `json:"polygon,omitempty"`
	H3Cells      []string       `json:"h3Cells,omitempty"`
	H3Resolution int            `json:"h3Resolution,omitempty"`

	cellSet map[string]struct{}
}

// Contains determina si un punto pertenece a la zona.
// Prioriza el polígono si está definido; si no, usa la pertenencia por celdas H3.
func (z *Zone) Contains(p domain.Point) (bool, error) {
	if len(z.Polygon) >= 3 {
		return pointInPolygon(p, z.Polygon), nil
	}
	if len(z.cellSet) > 0 {
		cell, err := geo.Cell(p, z.H3Resolution)
		if err != nil {
			return false, fmt.Errorf("geofence: zona %s: %w", z.ID, err)
		}
		_, ok := z.cellSet[cell]
		return ok, nil
	}
	return false, nil
}

// pointInPolygon implementa el algoritmo de ray casting (par/impar).
func pointInPolygon(p domain.Point, poly []domain.Point) bool {
	inside := false
	n := len(poly)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		yi, xi := poly[i].Lat, poly[i].Lon
		yj, xj := poly[j].Lat, poly[j].Lon
		if (yi > p.Lat) != (yj > p.Lat) {
			xCross := (xj-xi)*(p.Lat-yi)/(yj-yi) + xi
			if p.Lon < xCross {
				inside = !inside
			}
		}
	}
	return inside
}

// Transition describe el resultado de evaluar un punto para un conductor.
type Transition struct {
	Entered  []string // IDs de zonas en las que el conductor acaba de entrar
	InLima   bool     // el punto está dentro de Lima Metropolitana
	LeftLima bool     // transición: estaba en Lima y ahora salió
}

// Detector mantiene el estado de pertenencia por conductor para detectar transiciones.
type Detector struct {
	mu     sync.Mutex
	zones  []Zone
	bbox   BBox
	inside map[string]map[string]struct{} // driverID → zonas actuales
	inLima map[string]bool                // driverID → estaba en Lima en el último ping
}

// NewDetector crea un detector con las zonas dadas y el bbox de Lima.
func NewDetector(zones []Zone) (*Detector, error) {
	prepared := make([]Zone, 0, len(zones))
	for _, z := range zones {
		if z.ID == "" {
			return nil, fmt.Errorf("geofence: zona sin id")
		}
		if len(z.Polygon) < 3 && len(z.H3Cells) == 0 {
			return nil, fmt.Errorf("geofence: zona %s sin geometría válida", z.ID)
		}
		if len(z.Polygon) < 3 {
			z.cellSet = make(map[string]struct{}, len(z.H3Cells))
			for _, c := range z.H3Cells {
				z.cellSet[c] = struct{}{}
			}
		}
		prepared = append(prepared, z)
	}
	return &Detector{
		zones:  prepared,
		bbox:   LimaBBox,
		inside: make(map[string]map[string]struct{}),
		inLima: make(map[string]bool),
	}, nil
}

// Evaluate procesa un punto de un conductor y devuelve las transiciones detectadas.
func (d *Detector) Evaluate(driverID string, p domain.Point) (Transition, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	current, ok := d.inside[driverID]
	if !ok {
		current = make(map[string]struct{})
		d.inside[driverID] = current
	}

	var entered []string
	for i := range d.zones {
		z := &d.zones[i]
		contains, err := z.Contains(p)
		if err != nil {
			return Transition{}, err
		}
		_, was := current[z.ID]
		switch {
		case contains && !was:
			current[z.ID] = struct{}{}
			entered = append(entered, z.ID)
		case !contains && was:
			delete(current, z.ID)
		}
	}

	nowInLima := d.bbox.Contains(p)
	wasInLima, seen := d.inLima[driverID]
	d.inLima[driverID] = nowInLima

	return Transition{
		Entered:  entered,
		InLima:   nowInLima,
		LeftLima: seen && wasInLima && !nowInLima,
	}, nil
}

// Forget elimina el estado de un conductor (al desconectarse / quedar offline).
func (d *Detector) Forget(driverID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.inside, driverID)
	delete(d.inLima, driverID)
}

// ZoneCount devuelve el número de zonas configuradas.
func (d *Detector) ZoneCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.zones)
}
