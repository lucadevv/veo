# ADR 020 — Reactividad del flujo de puja (cerrar el loop realtime pasajero↔conductor↔admin)

> Estado: **EN PROGRESO** (Lote 1 arrancado). Fecha: 2026-07-02.
> Cierra las inconsistencias de UX del flujo de puja on-demand halladas en el audit crítico 2da-pasada
> (3 agentes, verificado nivel 1). La infra de puja EXISTE (lista de ofertas, accept-one-of-many con CAS
> single-winner, handlers de socket) pero **el loop realtime no cierra**: todo depende del poll de 5s.

## 0. Síntomas del dueño → causas raíz (todas file:line, verificadas)

1. **PUSH STARVATION (ALTO)** — "al re-pujar no sale el timer" + "no veo las ofertas":
   - `trip.bid_posted` es ORPHAN: ningún BFF lo consume (`public-bff realtime-consumer.service.ts:88-119`) → el board fresco (con `expiresAt` autoritativo recalculado en `openBoard`) nunca se pushea al pasajero.
   - `onRebid={() => undefined}` no-op (`tripPhaseDescriptors.tsx:199`) → la cache de `['trip',id,'offers']` retiene el board EXPIRED con `expiresAt` vencido → `OffersBody` pinta el spinner "tardando" en vez del countdown.
   - Ninguna mutación (rebid/accept/cancel) hace `invalidateQueries` → transiciones laggean hasta 5s.
   - `onOfferMade` nunca `setStatus` (`realtime-consumer.service.ts:237`) → en reconexión el snapshot re-pushea el `EXPIRED` stale sobre un board sano.
2. **AUCTION DE UNA SOLA VÍA (ALTO)** — "la oferta venció / no coordina":
   - Socket del conductor sin evento de oferta-rechazada/board-cerrado; `dispatch.offer_withdrawn` NO lo consume driver-bff (`kafka-consumer.service.ts:78-97`) → perdedores nunca notificados.
   - "Aceptar S/X" del conductor NO gana el viaje (manda offer PENDING, no navega — `bidding-usecases.ts:17-25`).
   - Branch PUJA nunca `clearOffer` (`RealtimeManager.tsx:101-107`) → FIXED→PUJA deja "Viaje entrante" fantasma → aceptar la vieja = 404.
3. **SURFACING débil (MED)** — "cómo elijo entre varias": sheet queda en peek (no crece al llegar ofertas, `tripPhaseDescriptors.tsx:502`); oferta pusheada flaca (solo price+ETA, sin rating/vehículo, `schemas.ts:451`); copy "Elige por precio, rating o llegada" miente (sort fijo, sin control); header "0 conductores respondieron" en búsqueda.
4. **LEGACY divergente (MED)** — `OffersBoardScreen`/`NoOffersScreen` reachable (Reassign→OffersBoard) SIN countdown.
5. **Reloj local (MED)** — countdown del conductor usa `Date.now()` (`useCountdownMs.ts:19`), no el server-authoritative (el pasajero ya migró).

**Lo que YA está bien (no regresar):** endpoint lista de ofertas + accept-one-of-many con CAS single-winner; handlers `offer:made/withdrawn` reactivos con merge dedup; 4-estados; socket vivo en EXPIRED/REASSIGNING.

## 1. Decisión — cerrar el loop realtime, sin re-arquitectura

Referencia de industria: inDrive/Yango — la puja es un board reactivo (ves las ofertas llegar en vivo,
elegís una de varias por precio/ETA/rating, el timer siempre corre). VEO tiene la infra; falta el PUSH +
la coordinación de cierre. Regla del dueño: **cada lote INTERACTÚA (boot-real cruzado entre apps) al cerrar.**

### Lotes
- **Lote 1 — PUSH STARVATION (causa #1).**
  - *Cliente (keystone):* en el re-bid OK, limpiar el board stale de la cache (`expiresAt`→null → el
    countdown cae al fallback local de 60s al instante) + `invalidateQueries(['trip',id])` (refetch →
    board fresco + status REQUESTED). Idem invalidación en accept/cancel donde aplique.
  - *Backend (push):* public-bff consume `trip.bid_posted` → push `trip:update {status: REQUESTED}` al
    pasajero (la fase vuelve a searching sin poll). `onOfferMade` → `setStatus` a estado de board-abierto
    para que la reconexión no re-pushee EXPIRED stale; el snapshot de reconexión incluye la lista de ofertas.
- **Lote 2 — AUCTION DE UNA SOLA VÍA (causa #2):** driver-bff consume `dispatch.offer_withdrawn` → push
  al conductor (su card muere reactiva); el conductor tras aceptar/contraofertar entra en estado
  "esperando al pasajero"; el branch PUJA hace `clearOffer` (mata el "Viaje entrante" fantasma).
- **Lote 3 — SURFACING (causa #3):** auto-expandir el sheet al llegar ofertas; enriquecer el push con
  rating/vehículo (o dejar el copy honesto); sort real o quitar la promesa; header sin "0 conductores".
- **Lote 4 — LEGACY (causa #4):** rutar Reassign al sheet unificado o borrar las pantallas legacy.
- **Lote 5 — Reloj (causa #5):** el countdown del conductor usa el `expiresAt` server-authoritative.

## 2. Verificación (cada lote)
tsc + tests + `auditar-core` (scope del lote) + **BOOT-REAL cruzado**: re-pujar en el pasajero → el timer
aparece al instante + las ofertas del conductor se ven llegar + aceptar una lleva al viaje. No se entrega
un lote sin ver el efecto reactivo en vivo entre las apps.
