# ADR 021 — Hardening del flujo de puja (integridad driver-trip · dinero · concurrencia · lifecycle)

> Estado: **EN PROGRESO** (Fase A arrancada). Fecha: 2026-07-02.
> Consolida el audit exhaustivo del flujo de puja (6 Explore agents, 2 rondas, verificado nivel 1). El
> motor de UN board es sólido (single-winner CAS + revert + N5 reconciler; dinero bid→agreedFare→charge
> H12/H13; matriz de cancelación; resolveTripPhase puro del server). Los gaps son SISTÉMICOS alrededor de
> la integridad driver↔trip, el dinero, la concurrencia y el lifecycle. Refina ADR-010/011/013/020.

## 0. Through-line (la causa raíz de la mitad)

**El conductor NUNCA se marca `ON_TRIP`/`ASSIGNED` en identity** (no hay consumer de identity para
`dispatch.match_found` / asignación). El check `ON_TRIP` del `eligibility.gate` está MUERTO, `markBusy`
se escribe pero no se lee en el accept, y no hay señal reactiva de driver-offline. De ahí: doble-win,
accept a driver recién-offline, y sin release del pool.

## 1. Hallazgos por tema (severidad · evidencia file:line)

### 🔴 A — Integridad driver 1-viaje (CRÍTICA)
- **A1** driver gana N viajes: accept CAS es per-trip no per-driver (`redis-offer-board.store.ts:109`); currentStatus nunca ON_TRIP; `markBusy` (`offer-board.service.ts:716`) nunca leído en `eligibility.gate.ts:94-194`; trip-service assign guarda per-trip. 2 pasajeros aceptan al mismo driver a la vez = ambos ganan.
- **A2** accept a driver recién-offline dentro del loc-TTL (identity sigue AVAILABLE) → luego B.

### 🔴 B — Señal de driver-offline / release del pool (CRÍTICA/ALTA)
- **B1** driver-offline tras ganar → SIN reassign: no hay `driver.went_offline`; `driver-status.ts:22-36` permite ON_TRIP→OFFLINE sin guard; watchdog pre-pickup 15min → EXPIRED (no reassign). Solo el cancel EXPLÍCITO reabre board (`trips.service.ts:1137,1222`).
- **B2** driver NO liberado del pool en `trip.cancelled`/`expired`/`failed` → busy 2h (BUSY_TTL 7200). `onTripCancelled` sin `releaseDriver`; el consumer (`kafka-consumers.service.ts`) no maneja expired/failed; comentario "mirror" miente. (`releaseDriver` solo en completed/reassigning.)

### 🟠 C — Dinero (ALTA)
- **C1** surge confiado del DTO del cliente sin re-quote server (`trip.dto.ts:115` → `trips.service.ts:506` `surge=dto.surgeMultiplier??1.0` → `fixed-dispatch.strategy.ts:45`). Cliente puede esquivar surge. Viola dinero-server-side. (PUJA no afectada: el bid es el precio.)

### 🟠 D — Concurrencia / guards (ALTA)
- **D1** sin índice único parcial `(passengerId) WHERE status IN (live)` → 2 requests concurrentes = 2 viajes (`trips.service.ts:470` check-then-act).
- **D2** create idempotente → 500 bajo doble-tap concurrente (sin catch P2002 en la tx, `trips.service.ts:593`).

### 🟠 E — Rating bilateral (ALTA)
- **E1** `rating tripId @unique` (`schema.prisma:30`) bloquea al 2do rater (`ratings.service.ts:91,125`); el comentario `:166` dice "DOS ratings" (contradicho) → rompe `passenger.flagged`.

### 🟠 F — Timing de oferta al conductor (ALTA)
- **F1** `expiresAt` calculado post-`await maps.eta()` (`matching.service.ts:325→331`) diverge de `offeredAt` → el driver ve más tiempo → aceptar tarde = 409.
- **F2** 12s default tenso (relay + 2do GET del fare). Ya admin-config (ADR-019); subir default ~20-25s.
- **F3** solo-driver: 1 sola oferta de 12s → no_offers, sin re-oferta.
- **F4** FIXED sin push FCM (no consumer notification de `dispatch.offered`) ni poll de respaldo (`/bids/open` es solo PUJA).

### 🟠 G — Driver cancel desde ASSIGNED (ALTA)
- **G1** cancel del driver desde ASSIGNED (pre-accept PUJA) es terminal, sin reopen (`POST_ACCEPT_STATES` excluye ASSIGNED, `trips.service.ts:130`).

### 🟠 H — UI = marioneta (ALTA/MED)
- **H1** el conductor decide el expiry con el reloj LOCAL → des-autoriza una puja válida (`CounterOfferSheet.tsx:61`); el pasajero ya lo arregló (display-only, espera EXPIRED del server) — asimetría.
- **H2** el panel de config del admin (Lote A / ADR-019) usó `onSuccess` en vez de `onSettled` (`queries.ts:947`) → read-model stale + loop de guardado muerto en 409. **Regresión introducida en ADR-019.**

### 🟡 Medias/Bajas
IN_PROGRESS offline→6h FAILED (I1) · SCHEDULED no en Kafka → admin ciego (I2, = ADR-019 D3) · board pujas sin orden + rebaraja cada 12s (I3) · FIXED vs PUJA pelean navegación + FIXED single-slot (I4) · cards expired linger 12s (I5) · CounterScreen fabrica ASSIGNED optimista (I6) · pending driver client-only no rehidratable (I7) · mergeOffers un-withdraw en evento stale (I8) · demand counter sin EXPIRE si crash post-INCR (I9).

## 2. Decisión — hardening por FASES (cada fase gated + boot-real cruzado)

- **Fase A (CRÍTICA) — driver 1-viaje. ✅ HECHA (verificada nivel 1: identity+dispatch tsc PASS + 264 tests + A2/B2 nuevos; falta boot-real cruzado).**
  - **A1** — `identity/trip-lifecycle.consumer.ts` (nuevo) mueve `Driver.currentStatus` por el ciclo (assigned→ASSIGNED, accepted/started→ON_TRIP, terminales→AVAILABLE) vía CAS `moveStatusForTrip` (idempotente, release recortado a estados activos). El `eligibility.gate` (AVAILABLE-only) ahora bloquea el 2do win por la puerta que ya existía.
  - **A2** — claim SÍNCRONO per-conductor en `acceptOffer`: `tryClaimDriver` (Redis SET NX LUA, idempotente mismo tripId) DESPUÉS del board-claim y ANTES de la tx durable; si falla → `revertClaim` (board→OPEN) + `ConflictError reason=driver_claimed` (409). Cinturón para la carrera de ~ms de 2 accepts al mismo driver.
  - **A-release/B2** — `releaseDriver` = `markAvailable` + `releaseClaim`; nuevos handlers `onTripExpired`/`onTripFailed` + `onTripCancelled` ahora libera (helper `releaseAssignedDriver`). Fin del stranded-busy 2h.
- **Fase B (CRÍTICA) — offline reactivo + release. ✅ HECHA (verificada nivel 1: events+identity+driver-bff+dispatch+trip tsc PASS + tests; falta boot-real cruzado).**
  - **B1** — evento `driver.went_offline {driverId, at, reason}` (enum `DRIVER_OFFLINE_REASON` shift_end|disconnect). Emit EXPLÍCITO: identity `setStatus`→OFFLINE (outbox, misma tx). Emit IMPLÍCITO (el crítico): driver-bff `handleDisconnect` arma timer de gracia `OFFLINE_GRACE_MS=20s`; al vencer, chequeo de presencia CROSS-NODO (`fetchSockets` vía redis-adapter) → si 0 sockets en NINGUNA réplica emite; si `fetchSockets` falla NO emite (un falso offline reasignaría un viaje vivo — peor que esperar el watchdog).
  - **B1 · par de sesión (cierre de deuda de audit, posterior)** — se agregó el evento ESPEJO `driver.went_online {driverId, at}` (identity emite en `startShift`, outbox en la MISMA tx del CAS OFFLINE→AVAILABLE) para dejar el ciclo de SESIÓN de turno completo en el WORM. El audit graba `went_online` (apertura) y `went_offline` SOLO en la rama `shift_end` (fin de turno deliberado · Ley 29733) vía `auditedWhen`; la rama `disconnect` de arriba NO se audita (best-effort, ruido de red). Ver `audit.consumer.ts` + `VEO_SPEC_ADMIN.md`.
  - **B-react** — dispatch `onDriverWentOffline`: `withdrawDriverOffers` (STALE + offer_withdrawn cycle-aware) + `evictDriver` (`hotIndex.remove`: evict loc+cell+busy+claim+presence — NO `markAvailable`, que re-metería al pool a un OFFLINE). trip-service `driver-offline.consumer` → `reassignForDriverOffline` rutea al `reassignAfterDriverCancel` existente (POST_ACCEPT → REASSIGNING → reabre board, respeta dispatchMode congelado + cap). **ASSIGNED queda fuera (necesita el cambio de máquina de Fase G).**
  - **Follow-ups flagged**: offline-reassign cuenta para auto-suspensión (fairness: distinguir disconnect vs cancel en trip.reassigning); grace 20s fijo (evaluar admin-config); BFF emite disconnect best-effort (no outbox; backstop = watchdog 15min).
- **Fase C — dinero. ✅ HECHA (public-bff tsc PASS + 67 tests trips, +3 Fase C).** public-bff `createTrip` re-cotiza el surge AUTORITATIVO server-side vía `DispatchService.getSurge(origin)` (reusa el cliente gRPC existente) y forwardea ESE valor; `dto.surgeMultiplier` queda display-only. Solo FIXED (`bidCents==null`); PUJA lo omite (el bid es el precio). Fail-safe: dispatch caído → 1.0 (nunca confía el cliente ni sobre-cobra). **Follow-up**: viaje PROGRAMADO debería re-cotizar surge en la activación, no en la creación.
- **Fase D — concurrencia.** índice único parcial per-passenger-live + catch P2002 → `ActiveTripExistsError`/return-existing.
- **Fase E — rating bilateral.** `@@unique([tripId, raterRole])` (o (tripId, direction)) en vez de `tripId @unique`.
- **Fase F — timing. ✅ F1+F2 HECHAS (dispatch tsc PASS + 269 tests).** F1: `expiresAt` anclado al `offeredAt` REAL de la DB (`created.offeredAt`, la misma base del sweep) → fin del 409 por divergencia con la latencia del eta. F2: default FIXED 12s→20s (env seed + fallback DEFAULT_RADIUS_CONFIG; sigue admin-configurable). **Pendientes F3 (re-offer al solo-driver) + F4 (FIXED sin push FCM/poll backstop).**
- **Fase G — cancel desde ASSIGNED** → REASSIGNING (incluir ASSIGNED en el reopen).
- **Fase H — UI marioneta.** **✅ H2 HECHA (admin-web tsc PASS):** `onSuccess`→`onSettled` en `useUpdateDispatchRadiusConfig` (queries.ts) → re-sincroniza el read-model tras 409 CAS, fin del loop de guardado muerto (regresión de ADR-019). **Pendiente H1:** portar el patrón display-only del pasajero al `CounterOfferSheet` (el conductor no debe des-autorizar por reloj local).
- **Fase I — medias/bajas** (observabilidad SCHEDULED, orden del board, navegación FIXED/PUJA, etc.).
- **Fase J — coherencia del countdown (modelo HÍBRIDO COHERENTE, decisión del dueño 2026-07-02).** El dueño cazó que se ven 3 tiempos para "una puja": pasajero 60s local (hardcode) · conductor FIXED 20s · conductor PUJA 60s; + sheet falso. Backend ya coherente (board.expiresAt fuente única). Decisión: mantener FIXED+PUJA (ADR-011) pero hacer la UX coherente:
  - **J1 ✅ HECHA (passenger tsc PASS + boot-real en vivo: mostró "Buscando conductores… 4:48" = board real 300s, no el fake 60).** Matado `SEARCH_WINDOW_SECONDS=60` (OffersBody.tsx); `useSearchCountdown` deriva SOLO de `board.expiresAt` y devuelve `hasWindow`; cuando es null (FIXED, o board aún no llegó) → "Buscando conductor…" INDETERMINADO (spinner, sin número, sin salto); `useRef` del fallback eliminado.
  - **J2 ✅ HECHA (driver tsc + 513 tests PASS).** Hook CANÓNICO único `shared/presentation/hooks/useCountdownMs.ts` (epoch ms) + helper `toEpochMs(iso)`; BidCard + CounterOfferSheet + TripIncomingScreen todos lo usan; borrado el `useCountdownMs` de bidding y el `useCountdown` local (ISO) de TripIncoming (+ useMemo/useRef muertos). Cero cerebro dividido.
  - **J3 ✅ HECHA.** Quitado el grabber DECORATIVO de `TripIncomingScreen` (línea 153 + su estilo): la oferta FIXED es un TAKEOVER full-screen honesto (oferta directa estilo Uber), no finge ser un bottom-sheet arrastrable como el de PUJA. El handle real vive solo donde hay gesto real (CounterOfferSheet).
  - **J4 ✅ HECHA.** Flag `pujaRebidNotice` en dispatchStore; RealtimeManager lo setea cuando el MISMO viaje que estaba en FIXED (`incomingOffer.tripId===payload.tripId`, leído por getState antes del clearOffer) re-abre como PUJA; BidsScreen muestra un `Banner` "Nueva ronda · ahora es puja" (auto-dismiss 6s, o se limpia al tapear una puja). i18n rebidNoticeTitle/Body.
  - **Pendiente J: boot-real cruzado** del banner J4 (necesita la danza FIXED→rebid→PUJA) + confirmar J3 sin grabber en vivo.
  - Ventana sigue difiriendo por mecánica (FIXED=turno del conductor vs PUJA=board compartido) — aceptado por el dueño; lo que se unifica es el LOOK + el encoding + la honestidad del pasajero.

## 3. Verificación (cada fase)
tsc + tests + `auditar-core` (scope de la fase) + BOOT-REAL cruzado entre superficies. No se entrega una
fase sin cerrar su hallazgo contra el código/DB en runtime.
