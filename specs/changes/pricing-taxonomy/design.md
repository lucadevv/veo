# Diseño — Pricing por tipo de servicio

## Modelo de dominio

**Un servicio tiene un TIPO; el tipo determina el MOTOR de precio.**

```
ServiceOffering
  id, labelKey, icon, vehicleClass, serviceType, requires, defaultEnabled, sortOrder
  serviceType ∈ { RIDE, SPECIAL, CARPOOL }   ← el eje que elige el motor
```

### Motor 1 · RIDE (viajes on-demand)
```
mode ∈ { FIXED, PUJA }              ← UNO por servicio (no schedule, no pin, no allowedModes)
multiplier                          ← tier (moto 0.55 … premium 1.8)
floorCents                          ← UN piso: es la mínima si FIXED, el piso de puja si PUJA
FIXED: fareCents = calculateFirmFare(base, {multiplier, minFareCents: floorCents})   [SIN CAMBIOS]
PUJA:  el bid ES el precio, validado bid ≥ floorCents
surge: multiplicador por demanda (dispatch), acotado por un TOPE admin global
```

### Motor 2 · SPECIAL (verticales)
```
tarifa PLANA por servicio (Ambulancia S/…, Grúa S/…, Mecánico S/…)
NO usa multiplier×km. Ambulancia/Grúa pueden sumar per-km del TRAMO de traslado (Fase B, opcional);
Mecánico es visita → plano puro.
```

### Motor 3 · CARPOOL (compartido programado)
```
seat_price = conductor (precioBase) ≤ tope
tope = floor( (distancia_km × costoPorKm[pais] + peaje) / asientos )   [SIN CAMBIOS — ya existe]
fee al pasajero = contribución × carpoolingFeeBps                       [SIN CAMBIOS]
```

## Qué se ELIMINA (D1)

| Elemento | Ubicación | Acción |
|---|---|---|
| `PricingModeRule` / franjas / `resolveMode(schedule)` | `trip-service/domain/pricing-mode.ts` | borrar el schedule por franjas |
| `resolveOfferingModeWithPin` / `resolveOfferingMode` / `overridden` / counter | `shared-types/catalog/offerings.ts`, `trips.service.ts` | borrar; el modo se lee de `offering.mode` |
| `offering.allowedModes` (cap) + `modePin` | `shared-types/catalog/offerings.ts` | reemplazar por `offering.mode: FIXED\|PUJA` |
| `schedule.defaultMode` global + pantalla de franjas | `admin-web` On-demand | borrar el card "Modo de tarificación" |
| doble piso (`minFareCents` + `floorCents` separados) | offerings + bid-floor | colapsar a UN `floorCents` por servicio (semántica según `mode`) |
| validación cruzada mínima↔piso | admin-web catalog-panel | ya no aplica (un solo piso) |

## Qué se AGREGA (D2 / Fase B)

- **Surge admin**: config global `SurgeConfig { maxMultiplier, enabled }` en trip-service; dispatch lee el tope; pantalla On-demand con la perilla.
- **SPECIAL flat pricing**: `serviceType === SPECIAL` → motor de tarifa plana (`flatFareCents` por oferta), fuera de la tabla de tiers. Mecánico sin per-km.
- **Carpooling reenmarcado** como el 3er tipo de servicio (motor cost-share ya existe; solo cambia el mapa mental / IA de la UI).

## Cambios por capa

- **`packages/shared-types`** (`catalog/offerings.ts`): `OfferingSpec.allowedModes` → `mode: PricingMode`; borrar `modePin`/`resolveOfferingMode*`; agregar `flatFareCents?` para SPECIAL. `OFFERINGS`: setear `mode` por oferta + sacar verticales del pricing de tiers.
- **`services/trip-service`**: borrar `domain/pricing-mode.ts` (schedule); `createTrip` lee `offering.mode` (resolve-once sigue: se congela en `Trip.dispatchMode`); un `floorCents` por servicio; SPECIAL → tarifa plana; `SurgeConfig` (Fase B). `calculateFirmFare` **intacto**.
- **`services/bff/admin-bff` + `packages/api-client`**: contratos — `mode` en vez de pin/schedule; un piso; endpoints de surge + flat (Fase B). Borrar el endpoint/vista de mode-schedule (franjas).
- **`apps/admin-web`**: On-demand (Tarifa base FIJO + Surge + Comisión, sin franjas); Viajes (tabla Modo[Fijo\|Puja]·Mult·Piso); Especiales (nueva, tarifa plana); Carpooling (igual, reenmarcado). Borrar `mode-schedule-panel` (franjas) + `bid-floor` global.
- **Diseño (`veo.pen`)**: On-demand ✅, Viajes ✅ (hechos). Falta: Especiales, Carpooling, nav de "Precios".

## Invariante money-critical

La fórmula del cobro FIXED (`calculateFirmFare`) **no se toca**. Con el modo resuelto per-servicio en vez de por schedule, un servicio hoy en FIXED sigue cobrando exactamente igual. La verificación debe probar: mismo `fareCents` para un viaje FIXED antes/después (los tests de `fare.spec` + `fixed-dispatch` no deben cambiar sus cifras).
