package geofence

import (
	"testing"

	"github.com/veo/tracking-service/internal/domain"
	"github.com/veo/tracking-service/internal/geo"
)

// Polígono cuadrado alrededor de Miraflores.
var mirafloresSquare = []domain.Point{
	{Lat: -12.13, Lon: -77.05},
	{Lat: -12.13, Lon: -77.01},
	{Lat: -12.10, Lon: -77.01},
	{Lat: -12.10, Lon: -77.05},
}

func TestPointInPolygon(t *testing.T) {
	inside := domain.Point{Lat: -12.12, Lon: -77.03}
	outside := domain.Point{Lat: -12.20, Lon: -77.10}

	if !pointInPolygon(inside, mirafloresSquare) {
		t.Error("el punto interior debería estar dentro del polígono")
	}
	if pointInPolygon(outside, mirafloresSquare) {
		t.Error("el punto exterior no debería estar dentro del polígono")
	}
}

func TestZonePolygonContains(t *testing.T) {
	z := Zone{ID: "miraflores", Polygon: mirafloresSquare}
	ok, err := z.Contains(domain.Point{Lat: -12.12, Lon: -77.03})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("Contains debería ser true para punto interior")
	}
}

func TestZoneH3Membership(t *testing.T) {
	p := domain.Point{Lat: -12.0464, Lon: -77.0428}
	cell, err := geo.Cell(p, 9)
	if err != nil {
		t.Fatal(err)
	}
	d, err := NewDetector([]Zone{{ID: "h3zone", H3Cells: []string{cell}, H3Resolution: 9}})
	if err != nil {
		t.Fatal(err)
	}
	tr, err := d.Evaluate("drv-1", p)
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Entered) != 1 || tr.Entered[0] != "h3zone" {
		t.Fatalf("se esperaba entrada en h3zone, got %+v", tr.Entered)
	}

	// Un punto en otra celda no debe pertenecer.
	tr2, err := d.Evaluate("drv-2", domain.Point{Lat: -12.20, Lon: -76.90})
	if err != nil {
		t.Fatal(err)
	}
	if len(tr2.Entered) != 0 {
		t.Fatalf("no se esperaba entrada, got %+v", tr2.Entered)
	}
}

func TestLimaBBox(t *testing.T) {
	if !LimaBBox.Contains(domain.Point{Lat: -12.0464, Lon: -77.0428}) {
		t.Error("Plaza de Armas debería estar dentro de Lima")
	}
	if LimaBBox.Contains(domain.Point{Lat: -13.5, Lon: -76.0}) { // Ica
		t.Error("Ica no debería estar dentro del bbox de Lima")
	}
}

func TestEntryTransitionFiresOnce(t *testing.T) {
	d, err := NewDetector([]Zone{{ID: "miraflores", Polygon: mirafloresSquare}})
	if err != nil {
		t.Fatal(err)
	}
	driver := "drv-1"
	outside := domain.Point{Lat: -12.20, Lon: -77.10}
	inside := domain.Point{Lat: -12.12, Lon: -77.03}

	// Empieza fuera: sin entrada.
	tr, _ := d.Evaluate(driver, outside)
	if len(tr.Entered) != 0 {
		t.Fatalf("sin entrada esperada al inicio, got %+v", tr.Entered)
	}
	// Entra: una entrada.
	tr, _ = d.Evaluate(driver, inside)
	if len(tr.Entered) != 1 {
		t.Fatalf("se esperaba 1 entrada, got %+v", tr.Entered)
	}
	// Sigue dentro: no se repite.
	tr, _ = d.Evaluate(driver, inside)
	if len(tr.Entered) != 0 {
		t.Fatalf("no debe repetirse la entrada, got %+v", tr.Entered)
	}
	// Sale y vuelve a entrar: nueva entrada.
	d.Evaluate(driver, outside)
	tr, _ = d.Evaluate(driver, inside)
	if len(tr.Entered) != 1 {
		t.Fatalf("re-entrada debe disparar de nuevo, got %+v", tr.Entered)
	}
}

func TestExitTransitionFiresOnce(t *testing.T) {
	d, err := NewDetector([]Zone{{ID: "miraflores", Polygon: mirafloresSquare}})
	if err != nil {
		t.Fatal(err)
	}
	driver := "drv-1"
	outside := domain.Point{Lat: -12.20, Lon: -77.10}
	inside := domain.Point{Lat: -12.12, Lon: -77.03}

	// Entra (sin salida todavía).
	tr, _ := d.Evaluate(driver, inside)
	if len(tr.Exited) != 0 {
		t.Fatalf("sin salida al entrar, got %+v", tr.Exited)
	}
	// Sale: UNA salida con la zona.
	tr, _ = d.Evaluate(driver, outside)
	if len(tr.Exited) != 1 || tr.Exited[0] != "miraflores" {
		t.Fatalf("se esperaba 1 salida de miraflores, got %+v", tr.Exited)
	}
	// Sigue afuera: no se repite la salida.
	tr, _ = d.Evaluate(driver, outside)
	if len(tr.Exited) != 0 {
		t.Fatalf("no debe repetirse la salida, got %+v", tr.Exited)
	}
}

func TestLeftLimaTransition(t *testing.T) {
	d, err := NewDetector(nil)
	if err != nil {
		t.Fatal(err)
	}
	driver := "drv-1"
	// Dentro de Lima.
	tr, _ := d.Evaluate(driver, domain.Point{Lat: -12.0464, Lon: -77.0428})
	if !tr.InLima || tr.LeftLima {
		t.Fatalf("primer ping en Lima: InLima=true, LeftLima=false; got %+v", tr)
	}
	// Sale de Lima → transición LeftLima.
	tr, _ = d.Evaluate(driver, domain.Point{Lat: -13.5, Lon: -76.0})
	if tr.InLima {
		t.Error("debería estar fuera de Lima")
	}
	if !tr.LeftLima {
		t.Error("debería detectarse la transición de salida de Lima")
	}
}

func TestDetectorRejectsInvalidZone(t *testing.T) {
	if _, err := NewDetector([]Zone{{ID: "", Polygon: mirafloresSquare}}); err == nil {
		t.Error("se esperaba error con zona sin id")
	}
	if _, err := NewDetector([]Zone{{ID: "bad"}}); err == nil {
		t.Error("se esperaba error con zona sin geometría")
	}
}
