# ADR 019 — Consistencia del match entre las 3 superficies + ventana de dispatch configurable por admin

> Estado: **PROPUESTO** (Lote 0 · diseño). Fecha: 2026-07-02.
> Cierra las inconsistencias del flujo de match on-demand entre pasajero / conductor / admin (auditadas
> con 2 pases file:line nivel 1) y lleva la ventana de puja/oferta a config de admin (molde ADR-013/radios).
> Refina ADR-010 (puja), ADR-011 (switch modo), ADR-013 (config runtime del admin).

---

## 0. Contexto y problema

Probando el match E2E aparecieron inconsistencias reales entre las 3 superficies. Auditoría (2 agentes,
evidencia file:line):

### 0.1 Lo que YA está bien (no se toca)

Enum de estado ÚNICO normalizado en los 3 (`@veo/api-client normalizeTripStatus`), sin drift. `trip.accepted`
fan-out a pasajero+admin OK. Offers board precio/countdown pasajero↔conductor con ventana autoritativa OK.
driver-online en /ops usa el mismo `DRIVER_LOC_TTL_SECONDS`. re-bid propaga `dispatch:offer` al conductor.

### 0.2 Los defectos (ranked)

| #   | Defecto                                                                                                                                                                                                                                                                                          | Evidencia                                                                                                                                                                 | Sev         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C   | **admin-bff NO consume `trip.expired`/`trip.failed`/`trip.reassigning`** (solo 8 eventos) → el read-model del /ops se CONGELA en el último estado → viajes fantasma "En curso" para siempre; KPI activeTrips ≠ lista. public-bff y driver-bff SÍ los consumen.                                   | `admin-bff/src/events/kafka-consumer.service.ts:23-32,99-115` vs `public-bff/.../realtime-consumer.service.ts:100-102` + `driver-bff/.../kafka-consumer.service.ts:41-52` | **ALTO**    |
| B   | **`rebid` abre SIEMPRE board PUJA sin honrar `Trip.dispatchMode`** → un viaje FIXED (que puede llegar a EXPIRED) se convierte en subasta de 60s y el `dispatchMode=FIXED` persistido MIENTE (viola ADR-011). Contraste: `reassignAfterDriverCancel` sí honra el modo (`forMode(mode).reassign`). | `trips.service.ts:1538-1620` (esp. `:1618`) vs `:1237-1238`                                                                                                               | **ALTO**    |
| A   | **La ventana de dispatch NO es admin-editable** (solo env, leída en el constructor = requiere restart): `DISPATCH_OFFER_TIMEOUT_MS=12000` (FIXED) + `BID_WINDOW_SEC=60` (PUJA). El dueño la quiere editable desde el admin como los radios.                                                      | `matching.service.ts:85` · `trips.service.ts:113,235` · `dispatch-mode.registry.ts:18`                                                                                    | **feature** |
| D1  | `reopenBoard` **hardcodea 60s**, ignora `BID_WINDOW_SEC` (diverge si la ventana ≠ 60)                                                                                                                                                                                                            | `offer-board.service.ts:241,255`                                                                                                                                          | MED         |
| D2  | FIXED usa radio env `DISPATCH_MAX_K_RING=2`; PUJA usa el runtime `matchKRing=4` → **FIXED ignora el panel de radios del admin**                                                                                                                                                                  | `matching.service.ts:86` vs `offer-board.service.ts:271`                                                                                                                  | MED         |
| D3  | Estados fantasma: `MATCHING` (solo public-bff lo sintetiza) y `SCHEDULED` (no está en el contrato Kafka) — el admin los declara en sus mappers pero nadie se los alimenta                                                                                                                        | `mappers.ts:126,128` · `schemas.ts` (sin `trip.scheduled`)                                                                                                                | MED         |
| D4  | `EXPIRED` clasificado 3 formas: pasajero-live re-biddable (correcto) vs pasajero-history terminal (deja al pasajero fuera del re-bid si re-entra por historial)                                                                                                                                  | `tripStatusClass.ts:13-19` vs `OffersBoardScreen.tsx:133`                                                                                                                 | BAJO        |

---

## 1. Decisión

**Cerrar las inconsistencias haciendo que las 3 superficies reflejen el MISMO estado, y llevar la ventana
de dispatch a config de admin (default + editable en runtime), sin re-arquitectura.** Regla transversal
del dueño: **al cerrar cada lote, INTERACTUAR (boot-real del match entre las apps + admin)**, no solo tsc.

### Lotes (orden validado C→B→A→D)

**Lote C — admin ingiere el ciclo completo (el /ops deja de mentir).**
admin-bff `kafka-consumer.service.ts` consume `trip.expired`, `trip.failed`, `trip.reassigning` (espejo 1:1
de public-bff/driver-bff): patch del read-model + emit `trip:update`. El resto del admin ya sabe mostrarlos.

**Lote B — el re-pujar honra el modo.**
`TripsService.rebid` ramifica por `Trip.dispatchMode`: FIXED → `emitTripRequested` (matcher secuencial);
PUJA → board. (O, si el producto quiere que re-pujar SIEMPRE sea subasta, PROMOVER a PUJA y **persistir**
`dispatchMode=PUJA` para que el valor congelado no mienta.) Decisión de producto a fijar en el apply.

**Lote A — ventana de dispatch admin-configurable (molde ADR-013/radios).**
Autoridad = **dispatch-service**. Extender el singleton `DispatchRadiusConfig` (o hermano
`DispatchWindowConfig`) con `offerTimeoutMs` + `bidWindowSec` (versionado, `replaceConfig`+outbox+cache).
`matching.service`/`offer-board.service` los leen **por-llamada** (no en el constructor). admin-bff
`dispatch-config` + admin-web panel (reusar `radius-config-panel`). Default DB = 12000/60. Revertir el hack
`DISPATCH_OFFER_TIMEOUT_MS=120000` del env de dev.

**Lote D — satélites.** D1 `reopenBoard` lee la ventana runtime (cae solo con A). D2 FIXED lee `matchKRing`
del admin (unifica radio). D3 decidir `MATCHING`/`SCHEDULED`: alimentarlos al admin o sacarlos de sus
mappers (no declarar lo que no se alimenta — degradación honesta). D4 alinear EXPIRED history↔live en pasajero.

## 2. Consecuencias

- El /ops del admin refleja en vivo lo que ven las apps (fin de los viajes fantasma) → ops puede intervenir
  en REASSIGNING (pasajero abandonado) como estaba diseñado.
- El re-pujar deja de falsificar el modo → el mismo viaje no cambia de mecánica.
- El dueño edita la ventana de puja desde el admin sin deploy.
- Sin strings mágicos nuevos, sin enum divergente (el contrato único ya existe).

## 3. Verificación (cada lote)

tsc + tests + `auditar-core` (scope del lote) + **BOOT-REAL del match entre las 3 superficies** (regla del
dueño: interactuar al solucionar). No se entrega un lote sin ver el efecto cruzado en vivo.
