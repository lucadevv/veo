// Package geo envuelve la librería H3 (uber/h3-go) para el cálculo de celdas
// usado por la presencia (hot index) y el geofencing.
package geo

import (
	"fmt"

	h3 "github.com/uber/h3-go/v4"

	"github.com/veo/tracking-service/internal/domain"
)

// Cell calcula el índice H3 (hex string) de un punto a la resolución dada.
func Cell(p domain.Point, resolution int) (string, error) {
	if resolution < 0 || resolution > 15 {
		return "", fmt.Errorf("geo: resolución H3 inválida: %d", resolution)
	}
	cell, err := h3.LatLngToCell(h3.NewLatLng(p.Lat, p.Lon), resolution)
	if err != nil {
		return "", fmt.Errorf("geo: LatLngToCell(%f,%f,r%d): %w", p.Lat, p.Lon, resolution, err)
	}
	return cell.String(), nil
}

// CellResolution devuelve la resolución de un índice H3 en formato hex.
func CellResolution(cellStr string) (int, error) {
	cell := h3.CellFromString(cellStr)
	if !cell.IsValid() {
		return 0, fmt.Errorf("geo: índice H3 inválido %q", cellStr)
	}
	return cell.Resolution(), nil
}

// CellCenter devuelve el centro geográfico de una celda H3.
func CellCenter(cellStr string) (domain.Point, error) {
	cell := h3.CellFromString(cellStr)
	if !cell.IsValid() {
		return domain.Point{}, fmt.Errorf("geo: índice H3 inválido %q", cellStr)
	}
	ll, err := cell.LatLng()
	if err != nil {
		return domain.Point{}, fmt.Errorf("geo: centro de celda %q: %w", cellStr, err)
	}
	return domain.Point{Lat: ll.Lat, Lon: ll.Lng}, nil
}

// CellsForPoint devuelve la celda de un punto en múltiples resoluciones (útil para indexar zonas).
func CellsForPoint(p domain.Point, resolutions ...int) (map[int]string, error) {
	out := make(map[int]string, len(resolutions))
	for _, r := range resolutions {
		c, err := Cell(p, r)
		if err != nil {
			return nil, err
		}
		out[r] = c
	}
	return out, nil
}
