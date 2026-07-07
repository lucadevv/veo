# Propuesta — Pricing unificado: UNA fórmula · parámetros por servicio · 3 modos

> Estado: **APROBADO (modelo)** · 2026-07-07 · Diseño a rehacer (veo.pen) · Código pendiente.
> Reemplaza el framing anterior de "3 motores / taxonomía por tipo" — era sobre-ingeniería (ver §Corrección).

## Problema

El pricing de VEO acumuló perillas y conceptos incoherentes frente a los modelos de referencia. Verificado (archivo:línea):

1. **El modo (PUJA/FIJO) se configura en 4 lugares** — default global, franjas horarias, pin por-servicio, `allowedModes` de código (`trips.service.ts:420-441`). Uber e inDrive: 0 perillas de modo visibles.
2. **Doble piso por servicio sin validación** — `minFareCents` (FIJO) + `floorCents` (PUJA) conviven, nada valida su relación.
3. **Código muerto** — las 5 ofertas RIDE tienen `allowedModes:[PUJA,FIXED]` idéntico → la intersección oferta∩schedule es no-op (`trips.service.ts:430`).
4. **Franjas sin uso** — `DEFAULT_SCHEDULE.rules=[]`; flipear el mecanismo por hora no tiene análogo (Uber flipea el PRECIO con surge, no el mecanismo).
5. **Surge a medio construir** — `surgeMultiplier` existe en la fórmula pero ninguna pantalla admin lo configura.
6. **Verticales forzados** — Mecánico ×1.0 cobra por-km sin trasladar.
7. **Carpooling huérfano** — pantalla aparte, desconectado del catálogo.

## Corrección (mi error inicial)

En una primera pasada propuse "3 motores de precio" (RIDE fórmula, SPECIAL flat, CARPOOL cost-share) y una taxonomía por tipo. **Era sobre-ingeniería.** La investigación con fuentes lo desmiente: **es UNA sola fórmula**; lo "flat" es simplemente `per-km = 0`.

## Investigación (fuentes)

- **Uber**: *"Every Uber tier uses the SAME four-part formula, just with different rates"* — `base + per-km·km + per-min·min + booking`, × surge, mínima. Cada producto = mismas piezas, otras tasas. ([RideWise](https://getridewise.com/blog/uber-fare-calculator-2026))
- **Grúa/tow**: hook-up fee (~$75) **+ per-milla** ($2–4). = `base + per-km`. ([HomeGuide](https://homeguide.com/costs/towing-service-cost))
- **Mecánico**: **por hora** ($175–250/h), **per-km = 0** (es una visita, no traslada). (id.)
- **Emergencia / after-hours**: **+20–50 %** = un multiplicador. (id.)
- **inDrive**: computa un *"recommended fare por ruta"* (la fórmula) y el pasajero **puja ≥ ese piso**. ([inDrive Help](https://indrive.com/help/passengers/how-fares-are-calculated))
- **BlaBlaCar**: el conductor pone el precio **≤ tope** (distancia × costo/km) ÷ asientos + service fee. = la misma base de distancia, el conductor pone el número topeado. ([Brineweb](https://www.brineweb.com/blog/blablacar-business-model-how-blablacar-works-and-makes-money))

## Decisión — UNA fórmula, dos ejes de variación

```
tarifa = ( base + perKm·km + perMin·min ) × multiplicador × surge     [piso: mínima]
```

Todo servicio ES esta fórmula. Cambian **solo dos cosas**:

1. **Parámetros por servicio** (algunos en CERO): `{base, perKm, perMin, multiplier, minFare}`. El global (banderazo/km/min) es el DEFAULT; cada servicio overridea lo que necesite. Mecánico → `perKm=0`; Grúa → `perMin=0`; Ambulancia → `multiplier` alto.
2. **Modo — quién pone el número**:
   - **FIJO** (Uber): la plataforma calcula la fórmula = el precio.
   - **PUJA** (inDrive): la fórmula da el piso/sugerido; el pasajero puja ≥.
   - **COST-SHARE** (BlaBlaCar): la fórmula da el TOPE; el conductor pone ≤, ÷ asientos + service fee.

**No hay "motor flat", ni "pricing de especiales", ni carril huérfano.** Hay: 1 fórmula · params por servicio · 3 modos. Las categorías (viaje / especial / carpooling) son solo AGRUPACIÓN del menú (presentación), ortogonales al precio.

## Alcance / No-goals

- **Money-safe**: la fórmula `calculateFirmFare` (base × multiplier, mínima, + fee niño plano) **YA es esta fórmula y no cambia**. El cambio es de la CAPA de resolución (modo per-servicio, params por servicio), no del cálculo.
- **No se toca**: biometría, pánico, video, KYC, liquidaciones, comisión (ya desacoplada), el `EnergySource` de la ficha del vehículo.
