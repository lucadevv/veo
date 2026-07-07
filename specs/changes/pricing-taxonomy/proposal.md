# Propuesta — Simplificación del pricing: modo per-servicio + taxonomía por tipo de servicio

> Estado: **APROBADO (modelo)** · 2026-07-07 · Diseño en curso (veo.pen) · Código pendiente
> Decisiones del dueño registradas en engram `architecture/pricing-taxonomy`.

## Problema

El pricing de VEO acumuló sobre-ingeniería y mezcló conceptos, volviéndose incoherente frente a los modelos de referencia (Uber/inDrive/BlaBlaCar). Incoherencias verificadas (archivo:línea):

1. **El modo (PUJA/FIJO) se configura en 4 lugares** — `schedule.defaultMode` global, `schedule.rules[]` (franjas horarias), `offering.modePin` (pin por-servicio), `offering.allowedModes` (cap de código). Precedencia: `allowedModes > modePin > franja > default` (`trips.service.ts:420-441`). Uber e inDrive: **0 perillas de modo**.
2. **Doble piso por servicio sin validación** — `minFareCents` (piso FIJO) y `floorCents` (piso PUJA) conviven por oferta; nada valida su relación → un admin puede invertirlos.
3. **Código muerto** — las 5 ofertas RIDE tienen `allowedModes: [PUJA, FIXED]` idéntico → la intersección oferta∩schedule es **no-op** (comentado en `trips.service.ts:430`). Toda la maquinaria `resolveOfferingMode`/`overridden`/counter no muerde hoy.
4. **Franjas horarias sin uso** — `DEFAULT_SCHEDULE.rules = []` (`pricing-mode.ts:50`); flipear el MECANISMO de pricing por hora no tiene análogo en Uber (que flipea el PRECIO con surge, no el mecanismo).
5. **Surge a medio construir** — existe `surgeMultiplier` [1.0–2.0] en la fórmula + `surgeQuote` en dispatch, pero **ninguna pantalla admin lo configura**.
6. **Verticales forzados al molde de viaje** — Ambulancia/Grúa/Mecánico (`allowedModes:[FIXED]`) se pricean con `multiplier × km`; Mecánico ×1.0 cobra por km cuando **no traslada** (es una visita).
7. **Carpooling huérfano** — es un servicio que el pasajero pide, pero vive en pantalla aparte con motor cost-share, desconectado del catálogo que dice ser "el menú de servicios".

## Referencia de industria

- **Uber**: UN catálogo con 10+ productos (X, Comfort, XL, Black, Reserve, y **Share/pool**), cada uno priceado por su lógica (Share = descuento ~0.7× sobre la misma fórmula). Eje dinámico = **surge**. Cero perillas de modo.
- **inDrive**: el pasajero puja ≥ un piso. Sin tiers, sin fórmula.
- **BlaBlaCar**: producto **separado**. El conductor pone el precio (cubre nafta/peaje), la plataforma lo **topea** (sin lucro → legalmente *cost-sharing*, no transporte comercial) + service fee. Programado, conductor no-profesional.

El carpooling de VEO es **BlaBlaCar** (no Uber Pool): motor genuinamente distinto.

## Decisiones

### D1 — Modo PER-SERVICIO (no híbrido con franjas)
Se elimina el flip de modo por franja horaria + el default global + el pin. El modo (**Fijo XOR Puja**) es UNA elección por servicio. **Un solo piso por servicio** (mínima si Fijo, piso si Puja — nunca los dos). **Surge = el eje dinámico** (como Uber). Se elimina el código muerto de `allowedModes`.

### D2 — Taxonomía por TIPO de servicio (el tipo determina el motor)
| Tipo | Servicios | Motor de precio |
|---|---|---|
| **Viajes on-demand** | Moto · Económico · Estándar · Premium · XL | tier × multiplicador · fijo/puja |
| **Especiales** | Ambulancia · Grúa · Mecánico | **tarifa PLANA** por servicio (no ×km) |
| **Carpooling** | compartido programado | conductor ≤ tope cost-share + service fee (BlaBlaCar) |

Carpooling deja de ser huérfano (3er tipo de servicio); los especiales salen de la tabla de tiers; los viajes quedan con la tabla fijo/puja.

## Alcance / No-goals

- **Money-safe**: la fórmula FIJO (`calculateFirmFare` = base × multiplier, con mínima, + fee niño plano) **no cambia**. La remoción es de la CAPA de resolución de modo, no del cálculo del fare.
- **No se toca**: biometría, pánico, video, KYC, liquidaciones/payouts, la comisión (ya desacoplada).
- El `EnergySource` de la ficha del vehículo (fleet/OCR) **no** es pricing y no se toca (el modelo de energía del pricing ya se removió antes).
