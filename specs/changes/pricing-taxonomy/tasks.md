# Tasks — Pricing por tipo de servicio (por fases)

> Regla: cada lote se entrega verificado (typecheck + tests + MCP en vivo) antes del siguiente.
> Money-critical: `calculateFirmFare` no cambia; probar paridad de `fareCents` FIXED.

## Fase 0 · Diseño (veo.pen) → aprobación del dueño
- [x] On-demand (`AdminPrecios`): Tarifa base (solo FIJO) + Surge + Comisión; fuera modo/franjas/energía/piso-global.
- [x] Viajes (`AdminTarifas`): tabla Categoría·Modo[Fijo\|Puja]·Multiplicador·Piso único·Activa; sin CrossWarn.
- [ ] **Especiales** (frame nuevo): Ambulancia/Grúa/Mecánico con tarifa PLANA por servicio.
- [ ] **Carpooling** (`AdminCarpooling`): reenmarcar como 3er tipo de servicio (cost-share ya está).
- [ ] **Nav de "Precios"**: On-demand · Viajes · Especiales · Carpooling.
- [ ] Aprobación del dueño sobre las frames → recién ahí baja a código.

## Fase A · Backend simplificación (bajo riesgo — mayormente REMOCIÓN)
- [ ] `shared-types/catalog/offerings.ts`: `allowedModes`→`mode: PricingMode`; borrar `modePin`, `resolveOfferingMode`, `resolveOfferingModeWithPin`, `overridden`. `OFFERINGS`: `mode` por oferta.
- [ ] `trip-service`: borrar `domain/pricing-mode.ts` (schedule/franjas) + sus specs; `createTrip` lee `offering.mode` (mantener resolve-once → `Trip.dispatchMode`); borrar la lectura del schedule.
- [ ] Colapsar el doble piso → UN `floorCents` por servicio (semántica según `mode`); borrar la validación cruzada.
- [ ] `admin-bff` + `api-client`: sacar el contrato de mode-schedule (franjas) + el pin; `mode` + un piso en el catálogo. Borrar endpoint/vista `mode-schedule`.
- [ ] `admin-web`: borrar `mode-schedule-panel` (franjas) + `bid-floor` global; On-demand sin franjas; catálogo con Modo[Fijo\|Puja] + un piso.
- [ ] **Verificar**: `calculateFirmFare` intacto; `fare.spec`/`fixed-dispatch.spec` mismas cifras; typecheck global; MCP en vivo (guardar modo per-servicio + un piso).

## Fase B · Aditivo
- [ ] **Surge admin**: `SurgeConfig { maxMultiplier, enabled }` en trip-service (singleton + CAS + outbox, espejo de base-fare); dispatch lee el tope; endpoint admin-bff + api-client; card Surge en On-demand cableado.
- [ ] **SPECIAL flat pricing**: `serviceType===SPECIAL` → motor de tarifa plana (`flatFareCents`); sacar verticales de la tabla de tiers; Mecánico sin per-km; pantalla Especiales en admin-web.
- [ ] **Carpooling**: reenmarcar en la IA como tipo de servicio (sin cambio de motor).
- [ ] **Verificar**: tests del surge (tope acota el multiplier) + del flat (Especiales no pasan por `calculateFirmFare` de tiers); MCP en vivo.

## Riesgos / notas
- El `mode` congelado en `Trip.dispatchMode` (resolve-once) NO cambia — solo cambia DE DÓNDE se resuelve (de la oferta, no del schedule). Reservas: se resuelve a la hora de recojo igual.
- Migraciones: si `offering.allowedModes`/`modePin` viven en DB (catalog override), la migración mapea a `mode`. Verificar el `CatalogOverride` de trip-service.
- CI pendiente aparte: triage de trivy (concurrent-ruby CRITICAL, undici HIGH, 2 private-keys de test → trivyignore).
