package geo

import (
	"testing"

	"github.com/veo/tracking-service/internal/domain"
)

// Punto de referencia: Plaza de Armas de Lima.
var limaCenter = domain.Point{Lat: -12.0464, Lon: -77.0428}

func TestCellResolution9(t *testing.T) {
	cell, err := Cell(limaCenter, 9)
	if err != nil {
		t.Fatalf("Cell: %v", err)
	}
	if cell == "" {
		t.Fatal("celda vacía")
	}
	res, err := CellResolution(cell)
	if err != nil {
		t.Fatalf("CellResolution: %v", err)
	}
	if res != 9 {
		t.Fatalf("resolución = %d, want 9", res)
	}
}

func TestCellDeterministic(t *testing.T) {
	a, err := Cell(limaCenter, 9)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Cell(limaCenter, 9)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("misma entrada debe dar misma celda: %q != %q", a, b)
	}
}

func TestCellCenterRoundTrip(t *testing.T) {
	cell, err := Cell(limaCenter, 9)
	if err != nil {
		t.Fatal(err)
	}
	center, err := CellCenter(cell)
	if err != nil {
		t.Fatalf("CellCenter: %v", err)
	}
	// El centro de la celda r9 debe estar a < ~0.01° del punto original.
	if abs(center.Lat-limaCenter.Lat) > 0.01 || abs(center.Lon-limaCenter.Lon) > 0.01 {
		t.Fatalf("centro de celda demasiado lejos: %+v vs %+v", center, limaCenter)
	}
}

func TestDifferentPointsDifferentCells(t *testing.T) {
	a, _ := Cell(domain.Point{Lat: -12.0464, Lon: -77.0428}, 9)
	b, _ := Cell(domain.Point{Lat: -12.10, Lon: -77.00}, 9)
	if a == b {
		t.Fatal("puntos distantes no deberían compartir celda r9")
	}
}

func TestCellInvalidResolution(t *testing.T) {
	if _, err := Cell(limaCenter, 16); err == nil {
		t.Fatal("se esperaba error con resolución 16")
	}
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
