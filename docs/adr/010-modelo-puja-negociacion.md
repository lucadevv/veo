# ADR 010 — Modelo de PUJA (negociación pasajero↔conductor)

> Estado: **RATIFICADO** (Lote 1 · spec sin código). Decisiones de producto cerradas (§9). Próximo: tasks → apply.
> Reemplaza el modelo implementado de **precio-fijo estilo Uber** por el **marketplace de puja**
> ("proponé tu precio") que es el diferenciador de VEO según el diseño (Claude Design) y el chat fundacional.

---

## 0. Contexto y problema

Auditoría (ver engram `audit/fidelidad-diseno`): el backend implementó **precio fijo** (`RouteQuoteScreen` →
`/maps/quote` por categorías → `createTrip` con `fareCents` fijo → dispatch asigna UN conductor
secuencialmente). Pero el **diseño y el negocio** definen un **marketplace de negociación**:

- **Pasajero**: pone su tarifa (`Offer` · "OFRECE TU TARIFA", piso S/7) → ve N conductores responder
  (`Offers` · "3 conductores respondieron", cada uno _acepta tu precio_ o _propone otro_) → elige.
- **Conductor**: ve la solicitud, **acepta el precio o contraoferta** (`Counter`, `MultiOffers`, `Waiting`).

Hoy NO existen endpoints de bid/contraoferta; dispatch ofrece secuencial y automático. Además, tres
catastróficos del backend viven JUSTO en este flujo (request→match→accept) y **los absorbe este rediseño**
en vez de parchearlos sobre el dispatch viejo (laburo tirado):

| Catastrófico (auditoría)                                               | Cómo lo cierra la puja                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4 conductor cancela ACCEPTED → pasajero abandonado, sin reasignación  | estado **REASSIGNING**: re-abre la puja al mismo precio                                                                                             |
| #5 no-driver dead-end (`dispatch.timeout` sin consumer; viaje colgado) | estado terminal **NO_OFFERS/EXPIRED** → pantalla NoOffers                                                                                           |
| #9 dispatch saltea el gate biométrico (matcheable por ping GPS)        | el conductor solo puede **ofertar** si es elegible (online + biométrico OK + no suspendido + vehículo) — gate server-side en el submit de la oferta |
| doble-accept (sin lock OFFERED)                                        | el match nace de **el pasajero elige UNA oferta**, no de aceptación concurrente                                                                     |

---

## 1. Decisión arquitectónica — ¿dónde vive la negociación?

**La negociación vive en `dispatch-service`. `trip-service` sigue siendo el dueño del ciclo de vida.**

Razón (bounded contexts limpios, ARQUITECTURA-Y-CALIDAD §3):

- **dispatch** ya es el dominio de matching en tiempo real: hot-index de conductores cercanos (Redis),
  entrega de ofertas (`OFFER_DELIVERY`), scorer, y ya emite `dispatch.offered`. Las ofertas son
  **efímeras y de alta frecuencia** → no deben vivir en el agregado Trip (lo bloatean).
- **trip** es el dueño del lifecycle/estado durable. Crea el viaje en `REQUESTED` (puja abierta) y solo
  transiciona a `ASSIGNED` cuando el pasajero acepta una oferta (dispatch emite el match elegido).

Esto **mantiene el split actual** (dispatch matchea → publica `match_found` → trip materializa ASSIGNED),
solo que el match ahora lo **elige el pasajero** entre ofertas reales, no lo elige el sistema.

```
PASAJERO                 trip-service           dispatch-service              CONDUCTOR(es)
   │ pone bid (fareCents) │                          │                            │
   ├─────── createTrip ──►│ REQUESTED + emite ───────►│ abre OfferBoard (OPEN)     │
   │                      │   trip.requested(bid)     │ broadcast a elegibles ────►│ ve la solicitud
   │                      │                          │◄── submit oferta (accept/  ─┤ acepta precio
   │◄── dispatch.offer_made (por cada oferta) ───────┤    counter, si ELEGIBLE)    │   o contraoferta
   │ elige UNA oferta ───────────────────────────────►│ offer_accepted             │
   │                      │◄── dispatch.match_found ──┤ CLOSED_MATCHED             │
   │                      │ ASSIGNED → … (lifecycle)  │                            │
```

---

## 2. Modelo de dominio (PLAYBOOK §2)

| Agregado                     | Dueño            | Qué es                                                   | Persistencia                             |
| ---------------------------- | ---------------- | -------------------------------------------------------- | ---------------------------------------- |
| **Trip**                     | trip-service     | el viaje y su lifecycle; `fareCents` = **bid aceptado**  | Postgres `trip` (durable)                |
| **OfferBoard** (negociación) | dispatch-service | la "subasta" de UN viaje: bid + ventana + ofertas        | Redis (efímero, TTL) + proyección mínima |
| **Offer**                    | dispatch-service | la respuesta de UN conductor (accept/counter) a un board | Redis (efímero)                          |

- **OfferBoard**: `{ tripId, passengerId, bidCents, vehicleType, origin, window, status }`.
- **Offer**: `{ boardId(tripId), driverId, kind: ACCEPT_PRICE | COUNTER, priceCents, etaSeconds, status }`.
  - `ACCEPT_PRICE`: acepta el `bidCents` tal cual. `COUNTER`: propone otro `priceCents` (> bid).
- **Pricing/piso**: el bid tiene un **piso anti-abuso** (hoy S/7, espejo de Admin · Tarifas — pantalla
  `Pricing` del diseño). El piso lo provee el motor de tarifas (no hardcode): `min(bidCents) = floor(zona)`.

---

## 3. Máquinas de estado (PLAYBOOK §4) — sub-estados incluidos

### 3.1 Trip (cambio MÍNIMO sobre la máquina actual)

La máquina actual (`trip-state-machine.ts`) **casi no cambia**. `REQUESTED` pasa a significar
"puja abierta". La transición a `ASSIGNED` la dispara **el pasajero al aceptar una oferta** (vía el match),
no el sistema. Se agrega `REASSIGNING` como sub-estado de la re-apertura tras cancelación del conductor.

```
SCHEDULED → REQUESTED(puja abierta) ──(pasajero acepta oferta → match)──► ASSIGNED → ACCEPTED → …
                  │                                                              │
                  ├─(ventana vence, 0 ofertas aceptables)──► EXPIRED  [NoOffers]  │
                  └─(pasajero cancela la puja)──► CANCELLED_BY_PASSENGER          │
                                                                                  │
            REASSIGNING ◄──(conductor cancela ACCEPTED, re-abre al mismo bid)─────┘
                  │
                  └─(re-match)──► ASSIGNED   |   (sin ofertas)──► EXPIRED
```

> El watchdog (Lote 0.5) ya cubre el caso degenerado "REQUESTED colgado" como backstop temporal.
> Acá agregamos el camino EXPLÍCITO y rápido: la ventana de puja vence → EXPIRED con evento.

### 3.2 OfferBoard (dispatch — la negociación)

```
OPEN ──(pasajero acepta una oferta)──► CLOSED_MATCHED
  │
  ├─(ventana de puja vence sin aceptación)──► EXPIRED        → trip EXPIRED, pantalla NoOffers
  └─(pasajero cancela)──────────────────────► CANCELLED
```

### 3.3 Offer (respuesta de un conductor)

```
PENDING ──(pasajero la elige)──► ACCEPTED      (→ las demás del board: LAPSED)
   │
   ├─(otra oferta elegida / board cierra)──► LAPSED
   ├─(conductor la retira)──────────────────► WITHDRAWN
   └─(el conductor tomó otro viaje)──────────► STALE   (caso de carrera, ver §5)
```

---

## 4. Contratos de eventos (extender la familia `dispatch.*`)

Ya existen `dispatch.match_found`, `dispatch.offered`, `dispatch.timeout`. Se agregan:

| Evento                     | Productor → consumidor                | Payload (núcleo)                                                      |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `trip.bid_posted`          | trip → dispatch                       | `{ tripId, passengerId, bidCents, vehicleType, origin, windowSec }`   |
| `dispatch.offer_made`      | dispatch → public-bff (pasajero)      | `{ tripId, driverId, kind, priceCents, etaSeconds }`                  |
| `dispatch.offer_countered` | dispatch → public-bff                 | `{ tripId, driverId, priceCents, etaSeconds }`                        |
| `dispatch.offer_accepted`  | dispatch (tras elección del pasajero) | `{ tripId, driverId, priceCents }` → deriva `dispatch.match_found`    |
| `dispatch.no_offers`       | dispatch → trip                       | `{ tripId, reason: 'window_expired' \| 'all_lapsed' }` → trip EXPIRED |
| `trip.reassigning`         | trip → dispatch                       | `{ tripId, bidCents }` (re-abre board tras cancel del conductor)      |

> `dispatch.timeout` (#5) queda **subsumido** por `dispatch.no_offers` (semántica clara para trip).
> Todos por outbox-in-transaction (regla #3 / FOUNDATION §6), idempotentes.

---

## 5. Caminos infelices (PLAYBOOK §5.3) — el "¿y si…?"

| ¿Y si…?                                                             | Resultado de diseño                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| nadie oferta en la ventana                                          | board EXPIRED → trip EXPIRED → **NoOffers** (pasajero re-puja más alto)            |
| todos contraofertan (nadie acepta el precio)                        | el pasajero ve los counters, elige uno o re-puja                                   |
| el pasajero acepta una oferta pero ese conductor ya tomó otro viaje | offer **STALE** → se le avisa, elige otra o re-puja (no se queda colgado)          |
| conductor contraoferta y el pasajero la ignora                      | la oferta **LAPSED** al cerrar el board / vencer su sub-TTL                        |
| pasajero cancela durante la puja                                    | board CANCELLED → trip CANCELLED_BY_PASSENGER                                      |
| conductor cancela DESPUÉS de aceptar (pre-recojo)                   | trip **REASSIGNING** → re-abre puja al mismo bid (cierra #4)                       |
| dos conductores "aceptan" a la vez                                  | no hay carrera: el match nace de que **el pasajero elige UNA**; las demás → LAPSED |
| conductor NO elegible intenta ofertar (curl)                        | **403** server-side: online + biométrico OK + no suspendido + vehículo (cierra #9) |
| doble-tap del pasajero al aceptar                                   | idempotente por `(tripId, driverId)`; segunda → no-op                              |

---

## 6. Matriz de acceso ROL ∩ OWNERSHIP (MENTORIA)

VEO no tiene PLAN (suscripción) para pasajeros/conductores → ejes = **ROL ∩ OWNERSHIP**.
La UI nunca autoriza; todo gate server-side (4 capas: guard → service re-valida → DB).

| Capacidad                     | ROL       | OWNERSHIP / regla server-side                                                     |
| ----------------------------- | --------- | --------------------------------------------------------------------------------- |
| Postear bid                   | pasajero  | sobre SU viaje; `bidCents ≥ floor(zona)`                                          |
| Ver ofertas de un board       | pasajero  | solo las de SU `tripId` (no IDOR — lección Lote 0)                                |
| Aceptar / re-pujar / cancelar | pasajero  | sobre SU board                                                                    |
| Ver bids abiertos cercanos    | conductor | solo si **ELEGIBLE**: online + biométrico OK + `!suspendedAt` + vehículo coincide |
| Submit oferta / contraoferta  | conductor | re-valida elegibilidad en el SERVICE (no solo guard) + el board está OPEN         |
| Aceptar el match propio       | conductor | solo si fue el elegido (`offer_accepted` de SU offer)                             |

> **Cierre estructural de #9**: la elegibilidad del conductor se enforce en el **submit de la oferta**
> (capa 2 guard + capa 3 service), no en un ping GPS. La presencia en el hot-index ya no autoriza ofertar.

---

## 7. Transversal (PLAYBOOK §9) — dominó y degradación

- **Notificaciones**: `dispatch.offer_made` → push al pasajero ("3 conductores respondieron"); `offer_accepted`
  → push al conductor elegido; `no_offers` → push al pasajero. (Engancha con el gap transversal del centro
  de notificaciones in-app, a resolver en el lote de apps.)
- **Pago**: el `fareCents` del viaje = el `priceCents` de la oferta aceptada (no el quote). El cobro
  canónico (Lote 0.4, `trip-completed:${tripId}`) no cambia.
- **Degradación honesta**: si no hay conductores elegibles en la zona → NoOffers honesto ("sin respuestas"),
  nunca un conductor falso.

---

## 8. Puntos de integración (para la fase tasks — NO es código todavía)

- **trip-service**: `createTrip` ya escribe `fareCents` → pasa a ser el **bid**; agregar `floor` desde el
  motor de tarifas; emitir `trip.bid_posted`; agregar transición `REASSIGNING`; consumir `dispatch.no_offers`
  y `dispatch.offer_accepted`.
- **dispatch-service**: `matching.service` deja de auto-ofertar secuencial; nace `OfferBoardService`
  (Redis + TTL) que broadcast el bid a elegibles y colecta ofertas; el gate de elegibilidad en el submit.
- **public-bff**: endpoints pasajero (postear bid, listar ofertas de SU board, aceptar/contra/cancelar) con
  ownership; realtime de `offer_made/countered` al socket del pasajero.
- **driver-bff**: endpoints conductor (listar bids elegibles, submit oferta/counter) con gate de elegibilidad.
- **packages/events**: los 6 schemas nuevos de §4.

---

## 9. Decisiones de producto — RATIFICADAS (2026-06-04)

1. **Ventana de puja**: **60s** abierta para recibir ofertas (default; ajustable por config/zona a futuro).
2. **Contraoferta**: **1 ronda** (MVP) — bid → conductores aceptan o contraofertan UNA vez → el pasajero
   elige. Sin regateo ida-y-vuelta. Coincide con el diseño (`Offers` = elegir).
3. **Piso del bid**: **Admin·Pricing por zona** — el motor de tarifas expone `floor(zona)`; el bid debe
   ser `≥ floor`. (Implica que la pantalla Admin·Pricing y el cálculo por zona existan antes del enforce;
   si no están listas al construir, degradar a un floor global temporal y migrar — degradación honesta.)
4. **Reasignación (#4)**: **permite SUBIR el bid** al re-abrir. ⚠️ **Diverge conscientemente del diseño**
   (la pantalla `Reassign` dice "mismo precio"). Decisión del dueño: tras cancel del conductor, quizá nadie
   aceptaba el precio original, así que el pasajero puede subirlo al re-pujar. Actualizar la pantalla Reassign
   en el lote de apps.
   - **Cómo se materializa (H6.4 · honestidad):** la reasignación AUTOMÁTICA (`reassignAfterDriverCancel`)
     re-abre el board INMEDIATAMENTE al bid **VIEJO** (`fareCents` actual) — no sube solo. La SUBIDA es una
     acción EXPLÍCITA del pasajero vía `POST /trips/:id/rebid {bidCents}`: el viaje vuelve a `REQUESTED` y
     se abre un board FRESCO al nuevo precio. Mismo endpoint reactiva un viaje `EXPIRED` (#12, ver abajo),
     que dejó de ser callejón sin salida (`EXPIRED → REQUESTED`). Regla del bid: `floor ≤ bid ≤ techo` (NO
     se fuerza a subir — la app sugiere, el dominio solo exige el rango). Re-pujar reinicia `reassignCount`.
5. **Surge**: **solo sugiere** — el `surge.service` influye el rango SUGERIDO que ve el pasajero, pero la
   puja manda (el pasajero pone su precio ≥ piso). El surge es guía, no obliga. Coherente con "proponé tu precio".

---

_Decisión: negociación en dispatch, lifecycle en trip. La puja cierra #4/#5/#9 + doble-accept by design.
Próximo: ratificar §9 → `tasks` por lotes verificables → `apply` (feliz → infelices → 4 estados)._
