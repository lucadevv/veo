package geofence

import (
	"encoding/json"
	"fmt"
	"os"
)

// LoadZonesFromFile lee zonas desde un archivo JSON: {"zones":[Zone,...]}.
// Si path está vacío devuelve una lista vacía (solo aplica el bbox de Lima).
func LoadZonesFromFile(path string) ([]Zone, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("geofence: leer zonas %q: %w", path, err)
	}
	var doc struct {
		Zones []Zone `json:"zones"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("geofence: parsear zonas %q: %w", path, err)
	}
	return doc.Zones, nil
}
