# Propuesta — Pricing unificado: UNA fórmula · parámetros por servicio · 3 modos

> Estado: **APROBADO (modelo)** · 2026-07-07 · Diseño a rehacer (veo.pen) · Código pendiente.
> Reemplaza el framing anterior de "3 motores / taxonomía por tipo" — era sobre-ingeniería (ver §Corrección).
> **ADR canónico del modelo:** [`docs/adr/023-modelo-pricing-coexistencia.md`](../../../docs/adr/023-modelo-pricing-coexistencia.md) (coexistencia FIJO·PUJA·COST-SHARE, modo per-service manual, surge afuera).

## Problema

El pricing de VEO acumuló perillas y conceptos incoherentes frente a los modelos de referencia. Verificado (archivo:línea):

1. **El modo (PUJA/FIJO) se configura en 4 lugares** — default global, franjas horarias, pin por-servicio, `allowedModes` de código (`trips.service.ts:420-441`). Uber e inDrive: 0 perillas de modo visibles.
2. **Doble piso por servicio sin validación** — `minFareCents` (FIJO) + `floorCents` (PUJA) conviven, nada valida su relación.
3. **Código muerto** — las 5 ofertas RIDE tienen `allowedModes:[PUJA,FIXED]` idéntico → la intersección oferta∩schedule es no-op (`trips.service.ts:430`).
4. **Franjas sin uso** — `DEFAULT_SCHEDULE.rules=[]`; flipear el mecanismo por hora no tiene análogo (Uber flipea el PRECIO con surge, no el mecanismo).
5. **Surge sin lugar** — `surgeMultiplier` existe en la fórmula pero ningún admin lo configura; y aplicado a los 3 modos rompería el cost-share (inflaría el cap = lucro, ilegal en BlaBlaCar). → se REMUEVE del modelo de pricing.
6. **Verticales mal modelados** — el Mecánico (una VISITA) se trataba como un viaje que cobra por-km, cuando no traslada a nadie.
7. **Carpooling mal encuadrado** — o "huérfano sin relación", o forzado como "una fila más" del catálogo. Es un producto propio (cost-share programado); ninguna de las dos.

## Corrección (mi error inicial)

En una primera pasada propuse "3 motores de precio" (RIDE fórmula, SPECIAL flat, CARPOOL cost-share) y una taxonomía por tipo. **Era sobre-ingeniería.** La investigación con fuentes lo desmiente: **es UNA sola fórmula**; lo "flat" es simplemente `per-km = 0`.

## Investigación (fuentes)

- **Uber**: *"Every Uber tier uses the SAME four-part formula, just with different rates"* — `base + per-km·km + per-min·min + booking`, × surge, mínima. Cada producto = mismas piezas, otras tasas. ([RideWise](https://getridewise.com/blog/uber-fare-calculator-2026))
- **Grúa/tow**: hook-up fee (~$75) **+ per-milla** ($2–4). = `base + per-km`. ([HomeGuide](https://homeguide.com/costs/towing-service-cost))
- **Mecánico**: es una **visita** — call-out plano upfront + **labor por hora cobrada DESPUÉS** (no se sabe al cotizar), **per-km = 0** (no traslada). (id.)
- **Emergencia / after-hours**: **+20–50 %** = un multiplicador. (id.)
- **inDrive**: computa un *"recommended fare por ruta"* (la fórmula) y el pasajero **puja ≥ ese piso**. ([inDrive Help](https://indrive.com/help/passengers/how-fares-are-calculated))
- **BlaBlaCar**: el conductor pone el precio **≤ tope** (distancia × costo/km) ÷ asientos + service fee. = la misma base de distancia, el conductor pone el número topeado. ([Brineweb](https://www.brineweb.com/blog/blablacar-business-model-how-blablacar-works-and-makes-money))

## Decisión — UNA fórmula, dos ejes de variación

```
tarifa = ( base + perKm·km + perMin·min ) × multiplicador     [piso: mínima]
```

Todo servicio ES esta fórmula. Cambian **solo dos cosas**:

1. **Parámetros por servicio** (algunos en CERO): `{base, perKm, perMin, multiplier, minFare}`. El global (banderazo/km/min) es el DEFAULT; cada servicio overridea lo que necesite. Mecánico → `perKm=0`; Grúa → `perMin=0`; Ambulancia → `multiplier` alto.
2. **Modo — quién pone el número**:
   - **FIJO** (Uber): la plataforma calcula la fórmula = el precio.
   - **PUJA** (inDrive): la fórmula da el piso/sugerido; el pasajero puja ≥.
   - **COST-SHARE** (BlaBlaCar): la fórmula da el TOPE; el conductor pone ≤, ÷ asientos + service fee.

**No hay "motor flat" ni "pricing de especiales" separados** — viajes, ambulancia y grúa son la MISMA fórmula (params + modo); las categorías viaje/especial son AGRUPACIÓN del menú. Pero hay **dos excepciones honestas** (ver Límites): el **Mecánico** (visita → call-out plano) y el **Carpooling** (producto cost-share propio, con su flujo y economía).

## Límites del modelo (dónde la fórmula NO estira)

La fórmula asume `km` (distancia) y `min` (duración) **conocidos al cotizar**. Eso vale para lo que **transporta** (viajes, ambulancia, grúa) — no para todo:

- **Visitas (Mecánico)**: el cliente no viaja (`perKm=0`) y la **labor no se sabe al cotizar** (el `perMin` de labor no existe aún). → NO es "la fórmula con ceros": es un **call-out plano** (`base`, perKm=perMin=0) cotizado upfront; labor/repuestos se cobran **aparte**, tras el diagnóstico.
- **Carpooling (COST-SHARE)**: es un **producto propio**, no una fila del catálogo de viajes. Comparte la **cuenta de distancia** (costo/km) pero tiene **flujo propio** (publicado/programado + reservar asientos), **params propios** (costo/km-cap por país · asientos · service fee) y **economía propia** (no-comercial: conductor 100 %, fee al pasajero). Vive en su **pantalla propia**.

**Conclusión honesta:** la unificación es REAL para **viajes on-demand que transportan** (FIJO=Uber + PUJA=inDrive, una fórmula + toggle de modo; ambulancia/grúa entran con multiplicador). El **Mecánico** degenera a call-out plano y el **Carpooling** es un producto aparte que comparte solo la cuenta de distancia. **No hay "una fórmula para todo": hay una fórmula de viaje + dos bordes honestos.**

## Alcance / No-goals

- **Money-safe**: la fórmula `calculateFirmFare` (base × multiplier, mínima, + fee niño plano) **YA es esta fórmula y no cambia**. El cambio es de la CAPA de resolución (modo per-servicio, params por servicio), no del cálculo.
- **No se toca**: biometría, pánico, video, KYC, liquidaciones, comisión (ya desacoplada), el `EnergySource` de la ficha del vehículo.
