# Tasks — Pricing unificado (por fases)

> Regla: cada lote se entrega verificado (typecheck + tests + MCP en vivo) antes del siguiente.
> Money-critical: `calculateFirmFare` no cambia; probar paridad de `fareCents` FIXED + un servicio con perKm=0.

## Fase 0 · Diseño (veo.pen) → aprobación del dueño
Rehacer sobre el modelo unificado (1 fórmula · params · 3 modos):
- [ ] **On-demand**: Tarifa base (los DEFAULT de la fórmula: banderazo/km/min) · Surge (tope) · Comisión.
- [ ] **Catálogo de servicios** (UNA tabla): Servicio · **Modo[Fijo\|Puja\|Cost-share]** · Multiplicador · Mínima · Activa. Overrides de params (base/perKm/perMin) en un detalle/avanzado por servicio (ej. Mecánico perKm=0).
- [ ] **Carpooling**: filas mode=COST_SHARE (costo/km país + service fee + ÷asientos) — dentro del mismo modelo, aunque su flujo (publicado/programado) sea aparte.
- [ ] Nav de "Precios" acorde. Aprobación del dueño → recién ahí, código.
- Nota: las frames actuales (On-demand ✅, Viajes ✅, Especiales, Carpooling) se REHACEN/ajustan a este modelo (Especiales deja de ser "flat aparte" → params + modo; ver corrección del proposal).

## Fase A · Backend simplificación (bajo riesgo — mayormente REMOCIÓN)
- [ ] `shared-types/catalog/offerings.ts`: `allowedModes`→`mode: PricingMode` (agregar `COST_SHARE` al enum); borrar `modePin`/`resolveOfferingMode`/`resolveOfferingModeWithPin`/`overridden`; `OfferingPricingPolicy` gana `baseFareCents?/perKmCents?/perMinCents?` opcionales. `OFFERINGS`: `mode` + params por oferta.
- [ ] `trip-service`: borrar `domain/pricing-mode.ts` (franjas/schedule) + specs; `createTrip` lee `offering.mode` (mantener resolve-once → `Trip.dispatchMode`); la fórmula usa params efectivos (`offering.pricing.perKmCents ?? globalPerKm`, etc.). `calculateFirmFare` intacto.
- [ ] Un `minFareCents` (fórmula) + `floorCents` solo si `mode===PUJA`; borrar la validación cruzada.
- [ ] `admin-bff` + `api-client`: contrato con `mode` + params opcionales; borrar endpoint/vista mode-schedule.
- [ ] `admin-web`: borrar `mode-schedule-panel` + `bid-floor` global; catálogo con Modo[Fijo\|Puja] + un piso.
- [ ] **Verificar**: `fareCents` FIXED idéntico (fare.spec/fixed-dispatch.spec); typecheck global; MCP en vivo.

## Fase B · Aditivo
- [ ] **Surge admin**: `SurgeConfig{maxMultiplier,enabled}` (singleton + CAS + outbox, espejo de base-fare); dispatch lee el tope; endpoint + card Surge cableado.
- [ ] **Params por servicio en la UI**: overrides base/perKm/perMin por oferta (Mecánico perKm=0, Grúa perMin=0). Verificar Mecánico = `base + perMin·min`, sin km.
- [ ] **COST_SHARE como modo**: unificar el pricing del carpooling bajo `mode=COST_SHARE` (el cost-cap ya es la fórmula con perKm=costoPorKm; ÷asientos + service fee). El flujo publicado/programado queda como está (operativo).
- [ ] **Verificar**: tests del surge (tope acota) + de params (perKm=0) + del cost-share (cap ÷ asientos); MCP en vivo.

## Riesgos / notas
- El `mode` congelado en `Trip.dispatchMode` (resolve-once) no cambia — solo cambia DE DÓNDE se resuelve (de la oferta, no del schedule).
- Migración: si `allowedModes`/`modePin` viven en el `CatalogOverride` de trip-service, mapear a `mode`. Params overrides = columnas/JSON nuevos opcionales (null = default).
- Categoría (RIDE/SPECIAL/CARPOOL) = solo agrupación del menú, no toca el precio.
- CI aparte: triage de trivy (concurrent-ruby CRITICAL, undici HIGH, 2 private-keys de test → trivyignore).
