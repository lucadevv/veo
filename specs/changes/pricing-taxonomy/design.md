# Diseño — Pricing unificado (1 fórmula · params · 3 modos)

## La fórmula (única, money-critical — YA EXISTE)

```
tarifa = max( round( (base + perKm·km + perMin·min) × multiplier ), minFare )   [+ FEE_NIÑO plano]
```

Es exactamente `calculateFirmFare(input, pricing)` de `trip-service/domain/fare.ts` (ya construido).
**No cambia.** Todo servicio la usa. Lo "plano" de un mecánico = `perKm=0` → la fórmula da `base (+ perMin·min)`.

## Los dos ejes de variación

### Eje 1 · Parámetros por servicio
El global (banderazo/km/min) es el DEFAULT. Cada oferta overridea lo que necesita:

| Servicio | base | perKm | perMin | multiplier | modo |
|---|---|---|---|---|---|
| Económico | (default 6) | (1.20) | (0.30) | 1.0 | FIJO/PUJA |
| Premium | (default) | (default) | (default) | 1.8 | FIJO/PUJA |
| Ambulancia | (default o mayor) | ✅ | ✅ | 2.5 (emergencia) | FIJO |
| Grúa | hook-up | ✅ | **0** | 1.0 | FIJO |
| Mecánico | call-out (S/50) | **0** | **0** (labor aparte) | 1.0 | FIJO |
| Carpooling | 0 | costo/km país | 0 | 1.0 | COST-SHARE (producto aparte) |

### Eje 2 · Modo (quién pone el número)
```
FIJO        → fareCents = fórmula                     (plataforma computa; ignora bid)
PUJA        → floor = fórmula; el pasajero ofrece ≥ floor; el conductor ACEPTA o CONTRA-OFERTA (inDrive)
COST-SHARE  → cap = fórmula; el conductor pone precio ≤ cap, luego ÷ asientos + service fee
```

## Modelo de datos

```
GlobalPricing (singleton on-demand)
  baseFareCents, perKmCents, perMinCents      ← DEFAULT de la fórmula
  commissionBps                                ← comisión (ya desacoplada)

ServiceOffering (por servicio)
  id, labelKey, icon, category, vehicleClass, requires, defaultEnabled, sortOrder
  mode ∈ { FIXED, PUJA, COST_SHARE }
  pricing: {
    baseFareCents?, perKmCents?, perMinCents?  ← overrides opcionales (null = usa el default global)
    multiplier
    minFareCents                                ← piso de la fórmula
    floorCents?                                 ← piso de PUJA (solo mode=PUJA) o cap-base de COST-SHARE
    seats?, serviceFeeBps?                       ← solo COST-SHARE
  }
  category ∈ { RIDE, SPECIAL, CARPOOL }         ← SOLO para agrupar en el menú (no afecta el precio)
```

`category` es presentación (cómo se agrupa en el picker del pasajero), **ortogonal** al motor. Ambulancia es `category=SPECIAL` pero se pricea con la misma fórmula que un viaje (mode=FIXED, multiplier alto).

## Qué se ELIMINA (vs hoy)

| Elemento | Ubicación | Acción |
|---|---|---|
| franjas / `resolveMode(schedule)` / `PricingModeRule` | `trip-service/domain/pricing-mode.ts` | borrar |
| `resolveOfferingModeWithPin` / `resolveOfferingMode` / `overridden` / counter | `shared-types`, `trips.service.ts` | borrar; el modo se lee de `offering.mode` |
| `allowedModes` (cap) + `modePin` | `shared-types/catalog/offerings.ts` | reemplazar por `offering.mode` |
| `schedule.defaultMode` global + card de franjas | `admin-web` On-demand | borrar |
| doble piso (min + floor separados sin relación) | offerings + bid-floor | un `minFareCents` (fórmula) + `floorCents` solo si PUJA |

## Qué se AGREGA

- `offering.mode ∈ {FIXED, PUJA, COST_SHARE}` (un solo modo por servicio).
- `pricing.{baseFareCents?, perKmCents?, perMinCents?}` overrides por servicio (Mecánico → perKm=0 **Y** perMin=0 = call-out plano; Grúa → perMin=0; etc.). Null = default global.
- Carpooling es un **producto propio** con `mode=COST_SHARE`: comparte la cuenta de distancia (`perKm=costoPorKm`) pero su **flujo** (publicado/programado + reservar asientos), sus **params** (costo/km-cap por país · asientos · service fee) y su **economía** (no-comercial: conductor 100 %, fee al pasajero) son suyos. Vive en su pantalla, **no** en el catálogo de viajes.

## Cambios por capa

- **`packages/shared-types`** (`catalog/offerings.ts`): `allowedModes`→`mode`; borrar `modePin`/`resolveOfferingMode*`; `OfferingPricingPolicy` gana overrides opcionales `{baseFareCents?, perKmCents?, perMinCents?}`. `OFFERINGS`: `mode` + params por oferta (Mecánico perKm=0, etc.).
- **`services/trip-service`**: borrar `domain/pricing-mode.ts`; `createTrip` lee `offering.mode` (resolve-once → `Trip.dispatchMode`); la fórmula usa params efectivos (override ?? default); COST_SHARE usa el cap. `calculateFirmFare` **intacto** (solo se le pasan los params efectivos; su `surgeMultiplier` queda en 1.0 — el surge se REMOVIÓ del modelo, no es config del admin).
- **`admin-bff` + `api-client`**: `mode` + params opcionales por oferta. Borrar mode-schedule (franjas).
- **`apps/admin-web`**: On-demand (Tarifa base default + Comisión); UN catálogo de servicios (Servicio · Modo · Multiplicador · Mínima · Activa, con overrides de params en un detalle/avanzado); carpooling como servicios mode=COST_SHARE. Borrar `mode-schedule-panel` + `bid-floor` global.

## Invariante money-critical

`calculateFirmFare` no cambia. Un viaje FIXED con params default sigue cobrando idéntico. Verificar: paridad de `fareCents` FIXED (los tests `fare.spec`/`fixed-dispatch.spec` mantienen sus cifras); un servicio con `perKm=0` da `base + perMin·min` (probar Mecánico).
