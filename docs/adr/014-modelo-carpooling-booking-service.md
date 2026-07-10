# ADR 014 — Modelo de carpooling: `booking-service` (marketplace PROGRAMADO)

> Estado: **RATIFICADO** (Cimiento F0/F1 · ADR sin código). Decisiones del dueño cerradas (§10).
> Materializa el **carril PROGRAMADO + FIJO + Perú** del modelo híbrido (`specs/VEO_MODELO_HIBRIDO.md` §6-9, §11 F0-F1):
> el marketplace de **carpooling** donde el conductor PUBLICA un viaje y el pasajero BUSCA y RESERVA un asiento.
> Define el servicio nuevo, los dos agregados (`PublishedTrip` + `Booking`), sus máquinas de estado tipadas,
> y el **cobro diferido charge-on-approval (SIN hold)** — la corrección consciente a la nota "hold→charge" del spec.
>
> 🔵 **NAMING RECONCILIADO por [ADR-023](./023-modelo-pricing-coexistencia.md) (2026-07-07):** el carpooling se
> confirma como **producto propio** (este servicio, aparte del catálogo on-demand) ✅. Pero su `pricingMode = FIJO`
> (el conductor fija un precio por asiento ≤ cost-cap) es, en la taxonomía de 023, el modo **COST_SHARE**
> (BlaBlaCar: conductor ≤ tope · ÷ asientos · service fee · no-comercial) — **NO** el `FIXED`=Uber (plataforma
> computa) del on-demand. Recomendado migrar el rótulo del enum del carpooling a `COST_SHARE` para no colisionar. Ver 023 §6.
>
> 🟠 **CORRECCIÓN — ratificada por el dueño (2026-07-10 · Estado: Corregido).** Consolida y hace CANÓNICA la
> decisión de cobro que este ADR ya venía materializando en §5, ahora cerrada por el dueño y anclada al contrato
> de FOUNDATION. Los puntos, explícitos y sin ambigüedad:
>
> 1. **`payment-service` y los rieles Yape/Plin NO soportan HOLD ni pre-autorización.** No hay estado `HOLD` en la
>    máquina de payment (`PENDING → [CAPTURED, FAILED, DEBT]`) y el push instantáneo Yape/Plin no pre-autoriza como
>    una tarjeta. La nota "hold→charge on approval" del spec (`VEO_MODELO_HIBRIDO.md` §8.1, §11 F3) queda **anulada**:
>    era imposible contra la realidad del riel. **No se le agrega HOLD a payment-service.**
> 2. **El modelo de cobro es `charge-on-approval` SIN pre-autorización.** Al **APROBAR** el booking se **cobra
>    directo** (transición `APROBADO → COBRO_PENDIENTE`, sin hold previo). El **método de pago se valida AL RESERVAR**
>    (gate de deuda `getDebtForPassenger` + `paymentMethod` en el `create-booking` DTO, §5.5), no al cobrar. Si el
>    conductor rechaza o expira el TTL → **no se cobró nada**.
> 3. **Cobro fallido → estado `DEBT` + reintento.** Si el CHARGE falla tras aprobar (`payment.failed`), corre BR-P02
>    (reintento, máx 3); si falla permanente el Booking va a `CANCELADO` y el gate "pasajero con deuda no reserva" se
>    **DERIVA de `PaymentStatus.DEBT` de payment-service** — booking **NO** crea un flag `DEBT` propio (una sola
>    fuente de verdad). El asiento NO se pierde: solo decrementa al capturar (§6).
> 4. **La idempotencia financiera (regla no-negociable #3) se mantiene intacta:** el charge-on-approval lleva
>    **`dedupKey = booking-charge:{bookingId}`** (`@unique` en payment) → reintentos del mismo Booking no duplican el
>    cobro; el evento se publica por **outbox pattern** (mutación de estado + `INSERT` outbox en la misma txn, §7).
> 5. **Las máquinas de estado de booking/PUJA y el estado `DEBT` quedan registradas como CONTRATO en
>    `docs/FOUNDATION.md`** (las agrega otro agente en paralelo). Este ADR las **referencia** como fuente canónica y
>    NO las duplica: el detalle operativo (transiciones, invariantes, secuencia) vive en §4–§6 de acá; el contrato
>    transversal, en FOUNDATION.
>
> Esta corrección **no reescribe** la decisión original: la §5 ("Cobro diferido — CHARGE-ON-APPROVAL") ya la
> materializaba; acá se deja el sello del dueño con fecha para trazar la evolución (spec decía hold → realidad del
> riel lo anuló → charge-on-approval + DEBT).

---

## 0. Contexto y problema

Hoy VEO es **solo on-demand** (`AHORA`: dispatch 1-a-1, urbano, `trip-service` + `dispatch-service` ya construidos
— ver ADR 008, 010). El **carril PROGRAMADO** (carpooling intercity, multi-pasajero, el conductor publica → el
pasajero reserva) **NO existe**: no hay agregado de viaje publicado, ni booking, ni el ciclo reservar→aprobar→pagar.

El norte es `specs/VEO_MODELO_HIBRIDO.md`:

- **§6-7**: el pasajero busca por ruta+fecha+#asientos y reserva; el conductor publica (origen→destino→stopovers→
  fecha/hora→asientos→precio FIJO).
- **§8.1**: las dos máquinas de estado (viaje publicado + booking por asiento).
- **§9**: las entidades `PublishedTrip` + `Booking` (multi-asiento).
- **§11**: el plan por fases. **F0 (cimiento de datos)** + **F1 (publicar viaje)** son el arranque — sin oferta
  publicada, la búsqueda del pasajero (F2) está vacía y nada conecta.

El spec dejó DOS decisiones abiertas que este ADR cierra:

1. **§9 "trip-service extendido o carpool-service — decidir"** → ¿dónde vive el carpooling? (§1, §2).
2. **§8.1 / §11 F3 "cobro diferido (hold→charge on approval)"** → ¿hold de verdad o no? El payment-service
   **no tiene HOLD** y los rieles PE dominantes (Yape/Plin, push instantáneo) tampoco. Se decide
   **charge-on-approval SIN hold** (§5) — corrección consciente al spec, anclada en la realidad del riel de pago.

**Fuera de scope de este ADR** (degradación honesta, §11): PUJA (`pricingMode=PUJA`, F6), el detalle multi-pasajero
del viaje EN VIVO (F4, lo ejecuta `trip-service`), payout al conductor (F5), y Ecuador/multipaís (F8). Acá se
resuelve el **cimiento** (F0) y la **publicación + el modelo transaccional** (F1→F3) en su capa de datos y estados.

---

## 1. Decisión arquitectónica — ¿dónde vive el carpooling?

**`booking-service`: un servicio NUEVO, dominio aislado. NO se extiende `trip-service`.**

Razón (bounded contexts limpios, DB-per-service, `ARQUITECTURA-Y-CALIDAD §3`):

- **`trip-service` es el dueño del VIAJE EN VIVO** (lifecycle on-demand, cámara, pánico, familia, modo niño —
  la fundación de seguridad ya construida). Su agregado `Trip` y su `trip-state-machine` están afinados para
  el ride 1-a-1. Meterle el marketplace (oferta publicada, N bookings por viaje, aprobación, cobro diferido)
  lo **bloatea** y acopla dos ciclos de vida que evolucionan distinto.
- **El carpooling es un MARKETPLACE** (oferta del conductor ↔ demanda del pasajero, con su propia máquina de
  reserva/aprobación/cobro). Es un dominio con su propio agregado raíz, sus invariantes (asientos, antelación)
  y su propio ritmo de cambio.

**Reusa el PATRÓN de `trip-service`, NO su código**: la misma anatomía (`service` / `repository` / `events` /
`state-machine` con `assertTransition` / `outbox`), el mismo envelope de eventos (UUIDv7 + `<domain>.<pastTense>`),
el mismo estilo de rieles (`InternalIdentityGuard` + `@Audiences`). Hereda la disciplina, no las tablas.

**Boundary** (DB-per-service, regla no negociable):

| Aspecto                  | `booking-service`                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Dueño de                 | `PublishedTrip` + `Booking` (+ su índice geo H3)                                                    |
| Schema                   | Postgres propio, schema lógico `booking` — NO comparte tablas con `trip`/`payment`/`identity`       |
| Relaciones cross-service | **por ID + eventos/gRPC** — nunca FK cross-schema                                                   |
| Puerto REST              | **3016** (próximo libre verificado)                                                                 |
| Puerto gRPC              | **50054** (próximo libre verificado)                                                                |
| Rol                      | **ORQUESTA el marketplace** (publicar→buscar→reservar→aprobar→cobrar). NO ejecuta el viaje en vivo. |

```
                       ┌──────────────────────────────────────────────────┐
   CONDUCTOR ──publica─►│                 booking-service                  │
   (driver-rail)        │  PublishedTrip  +  Booking  +  geo-index (H3)    │
                        │  charge-on-approval · outbox · state machines    │
   PASAJERO ──reserva──►│                                                  │
   (public-rail)        └───┬───────────┬───────────┬──────────┬──────────┘
                      gRPC  │     event │     event │    gRPC  │
                  GetDriver │  booking. │  booking. │ GetPay   │
                            ▼  started  ▼  cancelled▼          ▼
                       identity    trip-service   payment   payment
                       (status)   (Trip en vivo) (Refund)  (CHARGE/recibo)
```

---

## 2. Modelo de datos (PLAYBOOK §2) — los dos agregados

Dos agregados en el schema `booking`, relación **1 `PublishedTrip` → N `Booking`** (uno por pasajero).
Dinero **siempre en céntimos `Int`** (nunca float), moneda `PEN`. Geo en `lat`/`lon` + celda H3 (índice propio).

| Agregado          | Qué es                                                                              | Cardinalidad        |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------- |
| **PublishedTrip** | la OFERTA del conductor: ruta + fecha + asientos + precio FIJO + reglas             | raíz                |
| **Booking**       | la RESERVA de UN pasajero sobre un PublishedTrip (sus asientos, su precio acordado) | N por PublishedTrip |

### 2.1 `PublishedTrip` (la oferta)

| Campo                       | Tipo                      | Nota                                            |
| --------------------------- | ------------------------- | ----------------------------------------------- |
| `id`                        | UUID                      |                                                 |
| `driverId`                  | UUID                      | ref a identity (por ID, no FK)                  |
| `vehicleId`                 | UUID                      | ref a fleet (por ID)                            |
| `origenLat` / `origenLon`   | Float                     | + `originH3` (celda índice)                     |
| `destinoLat` / `destinoLon` | Float                     | + `destH3`                                      |
| `stopovers`                 | `Stopover[]`              | `{ lat, lon, orden }` paradas intermedias       |
| `fechaHoraSalida`           | DateTime                  | viaje PROGRAMADO (futuro)                       |
| `asientosTotales`           | Int                       |                                                 |
| `asientosDisponibles`       | Int                       | **decrementa con cada Booking CONFIRMADO** (§6) |
| `pricingMode`               | `PricingMode` enum        | **`FIJO`** (PUJA → F6, fuera de scope)          |
| `precioBase`                | Int                       | céntimos PEN — precio del asiento full-route    |
| `precioPorTramo`            | `TramoPrecio[]`           | `{ desdeOrden, hastaOrden, precioCentimos }`    |
| `modoReserva`               | `ModoReserva` enum        | `INSTANT_BOOKING` \| `REVISION_CADA_SOLICITUD`  |
| `reglas`                    | String                    | texto libre (equipaje, mascotas, etc.)          |
| `pais`                      | String                    | `PE` (EC → F8)                                  |
| `moneda`                    | String                    | `PEN`                                           |
| `estado`                    | `PublishedTripState` enum | máquina §4.1                                    |

### 2.2 `Booking` (la reserva)

| Campo                       | Tipo                | Nota                                                               |
| --------------------------- | ------------------- | ------------------------------------------------------------------ |
| `id`                        | UUID                |                                                                    |
| `publishedTripId`           | UUID                | ref al agregado raíz (mismo schema)                                |
| `passengerId`               | UUID                | ref a identity (por ID)                                            |
| `asientos`                  | Int                 | cuántos reserva este pasajero                                      |
| `pickupLat` / `pickupLon`   | Float               | puede ser un stopover                                              |
| `dropoffLat` / `dropoffLon` | Float               |                                                                    |
| `precioAcordado`            | Int                 | céntimos PEN — base + `specialRequest`                             |
| `mensajeIntro`              | String?             | mensaje al conductor                                               |
| `specialRequest`            | Int?                | `+X` céntimos sobre la base (top-up del diseño)                    |
| `paymentId`                 | UUID?               | seteado en el CHARGE (ref a payment, por ID)                       |
| `dedupKey`                  | String              | idempotencia financiera del CHARGE = derivada del `bookingId` (§5) |
| `estado`                    | `BookingState` enum | máquina §4.2                                                       |

> **No hay tabla `Bid`** en este ADR: PUJA (§8.2 del spec) es F6. **No hay tabla `Refund`**: se reusa el `Refund`
> de `payment-service` (§6, §9). **No hay tabla de pago propia**: el CHARGE y el recibo viven en `payment-service`.

---

## 3. Enums tipados (REGLA NO NEGOCIABLE: cero strings mágicos)

Los estados de ambas máquinas y todos los tipos van como **union types / enums TIPADOS**. El dominio NUNCA
compara strings sueltos: usa el enum + la state machine con `assertTransition` (§4.3). Estos son los contratos
(viven en `packages/events` / el `domain` del servicio — acá el PLANO, no el `.ts`):

```ts
// ── PublishedTrip ──────────────────────────────────────────────
enum PublishedTripState {
  BORRADOR = 'BORRADOR',
  PUBLICADO = 'PUBLICADO',
  PARCIALMENTE_RESERVADO = 'PARCIALMENTE_RESERVADO',
  LLENO = 'LLENO',
  EN_RUTA = 'EN_RUTA',
  COMPLETADO = 'COMPLETADO',
  CANCELADO = 'CANCELADO',
}

// ── Booking ────────────────────────────────────────────────────
enum BookingState {
  SOLICITADO = 'SOLICITADO', // reserva creada (Instant salta a APROBADO)
  PENDIENTE_APROBACION = 'PENDIENTE_APROBACION', // esperando al conductor (modo REVISION)
  APROBADO = 'APROBADO', // conductor aceptó → dispara el CHARGE (async)
  COBRO_PENDIENTE = 'COBRO_PENDIENTE', // CHARGE disparado, dinero AÚN no capturó (webhook en vuelo)
  RECHAZADO = 'RECHAZADO', // conductor rechazó (no se cobró)
  EXPIRADO = 'EXPIRADO', // TTL ~5min sin respuesta (no se cobró)
  CONFIRMADO = 'CONFIRMADO', // payment.captured → asiento decrementado
  EN_RUTA = 'EN_RUTA', // el viaje arrancó
  COMPLETADO = 'COMPLETADO',
  CANCELADO = 'CANCELADO', // +Refund por tier (o reembolso por asiento-lleno)
}

// ── Tipos del PublishedTrip (sin strings mágicos) ──────────────
enum PricingMode {
  FIJO = 'FIJO' /* PUJA → F6 */,
}
enum ModoReserva {
  INSTANT_BOOKING = 'INSTANT_BOOKING',
  REVISION_CADA_SOLICITUD = 'REVISION_CADA_SOLICITUD',
}

// ── Estado de pago consumido de payment-service (NO se redefine) ─
//    payment-service expone PaymentStatus: PENDING → [CAPTURED, FAILED, DEBT] (sin HOLD).
//    El cobro es ASÍNCRONO: nace PENDING y se CAPTURA después por webhook/poll.
//    booking-service NO posee esta máquina: la CONSUME por evento (payment.captured /
//    payment.failed) y, para gates puntuales, la LEE vía gRPC GetPayment. El estado DEBT
//    NO se replica en booking — se DERIVA de payment-service (PaymentStatus.DEBT).
```

---

## 4. Las dos máquinas de estado (PLAYBOOK §4)

### 4.1 `PublishedTrip` (la oferta)

```
BORRADOR ──publicar──► PUBLICADO ──(1er booking CONFIRMADO)──► PARCIALMENTE_RESERVADO
                          │                                          │
                          │              (asientosDisponibles == 0)──┤
                          │                                          ▼
                          │                                        LLENO
                          │                                          │
                          └──────────(fechaHoraSalida llega)─────────┤
                                                                     ▼
                                                                  EN_RUTA ──► COMPLETADO
   cualquier estado pre-viaje ──(conductor/admin cancela)──► CANCELADO
```

| Desde                                        | Evento                  | Hacia                    | Invariante                                                                         |
| -------------------------------------------- | ----------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `BORRADOR`                                   | publicar                | `PUBLICADO`              | driver no suspendido (gRPC `GetDriver`), `asientosTotales > 0`, `pricingMode=FIJO` |
| `PUBLICADO`                                  | 1er booking confirmado  | `PARCIALMENTE_RESERVADO` | `0 < disp < total`                                                                 |
| `PUBLICADO`/`PARCIALMENTE_RESERVADO`         | asiento decrementa a 0  | `LLENO`                  | `asientosDisponibles == 0`                                                         |
| `LLENO`                                      | cancela un pasajero     | `PARCIALMENTE_RESERVADO` | `disp > 0` (libera asiento)                                                        |
| `PUBLICADO`/`PARCIALMENTE_RESERVADO`/`LLENO` | `fechaHoraSalida` llega | `EN_RUTA`                | emite `booking.started` → trip-service crea el `Trip` (§F4)                        |
| `EN_RUTA`                                    | viaje termina           | `COMPLETADO`             |                                                                                    |
| `*` (pre-`EN_RUTA`)                          | conductor/admin cancela | `CANCELADO`              | dispara `booking.cancelled` por cada Booking activo (Refund por tier)              |

### 4.2 `Booking` (la reserva — el cobro ASÍNCRONO se orquesta acá)

El cobro **NO es síncrono**: al aprobar, booking dispara el CHARGE y el Booking entra a un estado intermedio
**`COBRO_PENDIENTE`** (aprobado, pero el dinero todavía no capturó). La confirmación llega **por EVENTO**
(`payment.captured` / `payment.failed`) cuando el webhook/poll de payment-service resuelve, minutos después.

```
                        modo INSTANT_BOOKING
                     ┌──────────(salta)──────────┐
                     │                            ▼
SOLICITADO ──REVISION──► PENDIENTE_APROBACION ──aprueba──► APROBADO ──dispara CHARGE──► COBRO_PENDIENTE ──[payment.captured]──► CONFIRMADO ──► EN_RUTA ──► COMPLETADO
                              │   │                                                          │                                      │
                       rechaza│   │TTL ~5min                                  [payment.failed → BR-P02 reintento;            (cancela)│
                              ▼   ▼                                            falla perm. → CANCELADO; o asiento-lleno          │   ▼
                          RECHAZADO  EXPIRADO                                  al capturar → Refund → CANCELADO]                 │  CANCELADO (+Refund por tier)
                          (sin cobro)(sin cobro)                                            │                                    │
                                                                                           ▼                                    │
                                                                                       CANCELADO ◄───────────────────────────────┘
                                                                                  (cobro fallido / asiento lleno → Refund)
```

| Desde                  | Evento                                   | Hacia                                 | Nota                                                                                                           |
| ---------------------- | ---------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| (crear)                | reservar, `modo=REVISION`                | `SOLICITADO` → `PENDIENTE_APROBACION` | valida método de pago AL RESERVAR vía `payment.GetPayment` (§5). NO se cobra                                   |
| (crear)                | reservar, `modo=INSTANT_BOOKING`         | `APROBADO`                            | **salta** `PENDIENTE_APROBACION`                                                                               |
| `PENDIENTE_APROBACION` | conductor aprueba                        | `APROBADO`                            | (gatillo del CHARGE)                                                                                           |
| `PENDIENTE_APROBACION` | conductor rechaza                        | `RECHAZADO`                           | terminal, **no se cobró nada**                                                                                 |
| `PENDIENTE_APROBACION` | TTL ~5min sin respuesta                  | `EXPIRADO`                            | terminal, **no se cobró nada**                                                                                 |
| `APROBADO`             | dispara CHARGE (async, `dedupKey`)       | `COBRO_PENDIENTE`                     | emite `booking.approved`. Asiento **NO** se decrementa todavía                                                 |
| `COBRO_PENDIENTE`      | consume `payment.captured`               | `CONFIRMADO`                          | AQUÍ corre la txn atómica: lock + decremento `asientosDisponibles` (§6), emite `booking.confirmed`             |
| `COBRO_PENDIENTE`      | `payment.failed` perm. (tras BR-P02)     | `CANCELADO`                           | gate de deuda **DERIVADO** de `PaymentStatus.DEBT` de payment-service (§5). Asiento intacto (no se decrementó) |
| `COBRO_PENDIENTE`      | `payment.captured` pero asiento ya lleno | `CANCELADO`                           | **camino infeliz**: otro confirmó el último asiento primero → Refund automático (§6)                           |
| `CONFIRMADO`           | viaje arranca                            | `EN_RUTA`                             | parte del `booking.started` del PublishedTrip                                                                  |
| `EN_RUTA`              | viaje termina                            | `COMPLETADO`                          |                                                                                                                |
| `CONFIRMADO`           | pasajero/conductor cancela               | `CANCELADO`                           | `booking.cancelled` con `tier` de antelación → Refund                                                          |

### 4.3 `assertTransition` — la regla, no el `if`

Cada máquina expone un mapa `Record<Estado, Estado[]>` de transiciones legales y un `assertTransition(from, to)`
que **tira** si la transición no está en el mapa. Ninguna mutación de estado se hace comparando strings a mano:
se invoca `assertTransition` → se muta → se escribe el evento, **todo en la misma transacción** (§7, outbox).

---

## 5. Cobro diferido — CHARGE-ON-APPROVAL (SIN hold)

**Decisión del dueño**: el pasajero reserva **SIN que se le toque la plata**. El cobro ocurre **cuando el
conductor APRUEBA** (transición `APROBADO → CONFIRMADO`). Si el conductor rechaza o expira el TTL → **no se
cobró nada**.

### 5.1 Por qué NO hold (la corrección al spec) + por qué el cobro es ASÍNCRONO

El spec decía "hold→charge on approval" (§8.1, §11 F3). **Imposible con la realidad del riel**:

- **`payment-service` NO tiene estado HOLD** — su máquina real es `PENDING → [CAPTURED, FAILED, DEBT]`.
- **El cobro de Yape/Plin es ASÍNCRONO** (verificado en `payment-service/src/payments/payments.service.ts`): el
  `charge()` nace `PENDING`, se completa por checkout (QR / deeplink / CIP `PENDING_EXTERNAL`) y se **CAPTURA
  DESPUÉS por webhook** (`applyWebhookResult`) o por el poll fallback (`PaymentPollService`). **NO** es una captura
  síncrona `PENDING→CAPTURED` en línea. Son **push instantáneo** sin pre-autorización/hold tipo tarjeta.

Dos consecuencias de diseño, ambas materializadas en este ADR:

1. **Se mantiene charge-on-approval SIN hold** — la DECISIÓN de fondo no cambia: el pasajero reserva sin que se le
   toque la plata; el cobro se dispara al APROBAR. **`payment-service` queda INTACTO** (no se le agrega `HOLD`).
2. **El MECANISMO es asíncrono-por-evento, no síncrono-en-línea** — al aprobar, booking dispara el CHARGE y queda
   esperando el evento `payment.captured` / `payment.failed`. No lee el resultado "en línea" porque la captura
   llega minutos después por webhook/poll.

### 5.2 La secuencia (paso a paso — ASÍNCRONA, confirmada por EVENTO)

```
1. RESERVAR        pasajero crea Booking → booking-service VALIDA que el pasajero NO tenga DEUDA
                   (gate DERIVADO vía getDebtForPassenger / REST GET /api/v1/payments/debt — NO GetPayment,
                   que es por paymentId y al reservar aún no existe) ANTES de aceptar la reserva.
                   Estado: PENDIENTE_APROBACION (o APROBADO si INSTANT). NO se cobra todavía.

2. APROBAR         conductor aprueba → Booking: PENDIENTE_APROBACION → APROBADO.
                   booking-service DISPARA el CHARGE vía REST POST /api/v1/payments/charge
                   (firmado service-rail) con tripId = bookingId (UUID OPACO para payment, NO un
                   Trip real) + dedupKey = booking-charge:{bookingId} (idempotencia financiera).
                   Guarda el paymentId que devuelve el charge en el Booking.
                   El Booking entra a COBRO_PENDIENTE (aprobado, dinero aún no capturó).
                   Emite booking.approved. El asiento NO se decrementa todavía.

3. ESPERAR EVENTO  booking-service NO lee el cobro en línea: CONSUME el evento que payment-service
   (no leer       emite cuando el webhook/poll resuelve la captura:
    en línea)        ✓ payment.captured → corre la TXN ATÓMICA (lock + decremento de asiento, §6):
                                          COBRO_PENDIENTE → CONFIRMADO, emite booking.confirmed.
                                          [si el asiento ya se llenó → abortar + Refund automático, §6]
                       ✗ payment.failed   → BR-P02: reintento (máx 3) → si falla permanente →
                                          Booking CANCELADO; el gate de deuda se DERIVA del
                                          PaymentStatus.DEBT de payment-service (§5.4).
```

### 5.3 Idempotencia financiera

El CHARGE lleva **`dedupKey = booking-charge:{bookingId}`** (idempotency key, distinta del `trip-completed:{tripId}`
canónico del on-demand para no colisionar). Reintentos del mismo Booking → la misma key → `payment-service` no
duplica el cobro (idempotencia por `dedupKey @unique`, `payment/schema.prisma:130`). Esto vuelve seguros los reintentos de BR-P02.

### 5.4 Fallo del cobro tras aprobar → DEBT (DERIVADO de payment-service)

La garantía que se pierde al no tener hold se mitiga así:

1. **Validar al RESERVAR** — método/saldo válido antes de aceptar la reserva (filtra el grueso de fallos).
2. **Reintento (BR-P02, máx 3)** — fallos transitorios del riel, gatillados al consumir `payment.failed`.
3. **`DEBT` DERIVADO** — payment-service YA tiene su propia política de deuda (`PENDING→DEBT`, `DEBT→CAPTURED`,
   endpoint de saldar deuda BR-P02). Si el cobro falla permanente, el Booking va a `CANCELADO` y el gate de
   "pasajero con deuda no puede reservar" se **DERIVA consultando `PaymentStatus.DEBT` de payment-service** vía
   `GetPayment` — **booking-service NO crea un flag DEBT propio** (sería una segunda fuente de verdad). El asiento
   NO se decrementó (solo decrementa al capturar, en `CONFIRMADO`), así que el viaje no perdió cupo por un cobro
   fallido.

> **Patrón aplicado (ARQUITECTURA §4-bis)**: esto es **transacción + idempotencia + reacción a evento**, NO saga
> distribuida con compensaciones encadenadas. El cobro es **asíncrono** (`charge` → webhook/poll → `payment.captured`),
> pero booking lo trata como un único punto de reacción: consume UN evento y corre UNA txn atómica (lock+decremento).
> El único camino compensatorio es el Refund del asiento-lleno (§6) — acotado, no una coreografía multi-paso.

### 5.5 Contrato REAL de payment-service (corrección as-built F3 — verificado 2026-06-22)

El contrato asumido en §5.2/§7 se reconcilió con `payment-service` real. Lo que cambia (payment queda **intacto** salvo el scoping de riel):

- **El CHARGE es REST, no gRPC**: `POST /api/v1/payments/charge` (firmado HMAC service-rail). Recibe `tripId` (obligatorio) + `dedupKey` + `grossCents` + `method` + `passengerId`. booking lo llama por un **InternalRestClient** (mismo patrón share→notification), no por gRPC.
- **`tripId = bookingId` (UUID opaco)**: payment NO valida el tripId contra trip-service (`payments.service.ts:177`), no hay `@unique` en `tripId`. El carpooling NO tiene Trip hasta F4, así que el bookingId viaja como el `tripId` del Payment. El evento `payment.captured` devuelve ese `tripId` → booking correlaciona el Booking por id (sin GetPaymentByTrip).
- **Gate de deuda al reservar = `getDebtForPassenger(passengerId)`** (REST `GET /api/v1/payments/debt`), NO `GetPayment` (que es por paymentId, inexistente al reservar). Deriva `hasDebt` de los Payment en `DEBT` + penalidades del pasajero.
- **`GetPayment(paymentId)` gRPC**: solo para leer estado/recibo del cobro ya disparado (el paymentId se guardó en el Booking al aprobar).
- **Riel (decisión del dueño 2026-06-22, mínimo privilegio)**: payment hoy expone un `ALLOWED_AUDIENCES` GLOBAL `[public, driver, admin]` sin service-rail (`payment/core.module.ts:29`). F3 le mete el patrón **per-método/per-endpoint** (como identity en F2) y abre a **service-rail SOLO** `charge` + `getDebt` + `GetPayment`. Refund/credit/GetPaymentByTrip NO se abren a service-rail.
- **Método de pago (decisión del dueño 2026-06-22)**: el **pasajero ELIGE el método al RESERVAR** (paridad con on-demand, donde el método viene del `Trip`). El `create-booking` DTO captura `paymentMethod` (PaymentMethod: YAPE/PLIN/CASH/...), persistido en el `Booking`; el CHARGE al aprobar (o al reservar si INSTANT) lo usa. La afiliación Yape on-file decide QR-vs-on-file **dentro** de YAPE y la resuelve payment server-side (`resolveActiveWalletUid`) — booking NO valida afiliación, solo pasa el método elegido. `payerRef` no se pasa (el walletUid on-file es server-side secret).
- **El MONTO del charge es SERVER-AUTHORITATIVE, jamás del cliente (endurecimiento as-built 2026-06-27)**. El `grossCents` se computa en el servidor según el RIEL del caller; un cliente NUNCA lo dicta:
  - **service-rail (booking → payment, carpooling)**: booking es un servicio interno confiable; calcula `grossCents = precioAcordado × asientos` server-side (incluye la corrección de **sub-cobro multi-asiento** y el **re-cap de `specialRequest` ≤ tope anti-lucro** que antes se evadía).
  - **public-rail (public-bff → payment, on-demand)**: el caller recibe al PÚBLICO, así que el BFF **NO reenvía el `grossCents` del cliente** (un pasajero posteaba `grossCents: 1` y pagaba S/0.01 — **amount-tampering**). Lo **deriva de la tarifa firme del viaje** (`trip.fareCents` vía `GetTrip` con el `passengerId` del JWT → viaje ajeno/inexistente = 404, **anti-IDOR**) y **EXIGE `trip.status === COMPLETED`** (si no, **409**): un cobro temprano fijaría el Payment con una tarifa en-curso y, vía la `dedupKey` compartida con `trip.completed` (`trip-completed:${tripId}`), **bloquearía el cobro de la tarifa final** (sub-cobro al conductor/plataforma). Cerrado en `public-bff/payments.service.ts` (`charge.spec.ts` lo blinda).

---

## 6. Concurrencia de asientos — el lock atómico

**El caso (agravado por el cobro asíncrono)**: un PublishedTrip con 1 asiento libre. Con cobro asíncrono, **N
pasajeros pueden tener el CHARGE EN VUELO para el mismo último asiento al mismo tiempo** (cada uno aprobado, en
`COBRO_PENDIENTE`, esperando su webhook). El primero cuyo `payment.captured` llega y corre la txn gana el asiento;
los demás capturan después y se encuentran el cupo agotado. Sin protección, dos handlers leerían
`asientosDisponibles = 1`, ambos decrementarían, y el viaje quedaría **oversold** (-1).

**Regla (MARCADA como invariante crítico)**: el `SELECT ... FOR UPDATE` + decremento de `asientosDisponibles` + la
transición `COBRO_PENDIENTE → CONFIRMADO` ocurren en **UNA transacción ACID atómica con bloqueo de fila**, y esa
transacción corre **DENTRO DEL HANDLER del evento `payment.captured`** — **NO** dentro de la transacción que disparó
el CHARGE (esa ya cerró: la captura llega minutos después por webhook). Esto es el corazón de la corrección async:

```
// HANDLER de payment.captured  (corre cuando el webhook/poll de payment-service resuelve la captura)
// CORRELACIÓN: el evento payment.captured trae tripId = bookingId → ubica el Booking por id directo
// (NO GetPaymentByTrip; el nexo es el tripId opaco del payload, payment/payments.service.ts:420).
BEGIN
  SELECT asientosDisponibles FROM published_trip WHERE id = :id FOR UPDATE   -- lock de fila
  IF asientosDisponibles < booking.asientos:
       // CAMINO INFELIZ: cobré pero el asiento ya se llenó (otro confirmó primero)
       UPDATE booking SET estado = 'CANCELADO' ...
       INSERT outbox (booking.cancelled  reason='asiento-lleno')   -- payment-service → Refund automático
       COMMIT  → FIN (el pasajero NO viaja, se le DEVUELVE la plata)
  UPDATE published_trip SET asientosDisponibles = asientosDisponibles - :asientos WHERE id = :id
  UPDATE booking SET estado = 'CONFIRMADO' ...
  INSERT outbox (booking.confirmed)
  IF asientosDisponibles == 0 → published_trip.estado = 'LLENO'
COMMIT
```

- El `SELECT ... FOR UPDATE` (lock pesimista de fila) serializa los handlers `payment.captured` concurrentes del
  mismo viaje: el segundo espera al primero, re-lee el valor ya decrementado.
- **Camino infeliz nuevo (degradación honesta)**: con cobro asíncrono ya **NO se puede "abortar sin cobrar"** — el
  dinero del segundo pasajero **ya capturó** cuando su handler corre. Si al lockear ya no hay asiento, se dispara
  **REEMBOLSO** (payment-service `Refund` vía `booking.cancelled`): cobré, pero el asiento se llenó → devuelvo
  automático. El primero en capturar gana; el segundo se reembolsa. Es el costo real de no tener hold + captura
  asíncrona, y se nombra explícito.
- La verificación del cupo vive **dentro** de la transacción del handler de captura, no antes ni en el disparo del
  CHARGE (chequear-y-confirmar como pasos separados sería la grieta de carrera). Un solo `published_trip` = una sola
  fila a lockear → barato.
- **No se necesita lock distribuido**: monolito-1-DB-por-servicio, la fila vive en el schema `booking`. ACID basta.

---

## 7. Eventos (PLAYBOOK §6) + gRPC

**Envelope**: UUIDv7 + nombre `<domain>.<pastTense>`, topic `booking`. **Outbox pattern**: la mutación de estado
y el `INSERT` en la tabla outbox van en la **MISMA transacción Prisma** (atomicidad estado↔evento). Idempotentes.

### 7.1 Eventos emitidos (topic `booking`)

> **Naming alineado (corrección as-built).** El nombre del evento refleja el AGREGADO y el ESTADO REAL — sin
> inversiones. La PUBLICACIÓN de un PublishedTrip es `booking.published` (NO `booking.created`: ese nombre
> sugería "se crea un Booking"). La creación de un Booking emite el evento del estado en que NACE: REVISION →
> `booking.requested` (PENDIENTE_APROBACION); INSTANT_BOOKING → `booking.approved` (nace APROBADO, §4.2) —
> emitir `booking.requested` en INSTANT sería semánticamente FALSO (mapearía a "→ PENDIENTE_APROBACION", un
> estado por el que el Booking NO pasa). El topic sigue siendo `booking` (el prefijo `booking.` lo preserva).

| Evento              | Cuándo                                                                                                                           | Consumidor núcleo                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `booking.published` | se PUBLICA un PublishedTrip (la OFERTA: BORRADOR → PUBLICADO)                                                                    | notification / búsqueda (índice geo F2)            |
| `booking.requested` | se crea un Booking en REVISION → `PENDIENTE_APROBACION`                                                                          | notification (push "tenés una solicitud")          |
| `booking.approved`  | Booking → `APROBADO`: (a) INSTANT_BOOKING al reservar (§4.2); (b) el conductor aprueba (F1) → dispara CHARGE → `COBRO_PENDIENTE` | notification (push "aprobado, cobrando")           |
| `booking.rejected`  | conductor rechaza (`RECHAZADO`)                                                                                                  | notification (avisa al pasajero)                   |
| `booking.expired`   | TTL ~5min vence (`EXPIRADO`)                                                                                                     | notification                                       |
| `booking.confirmed` | `payment.captured` consumido (`COBRO_PENDIENTE → CONFIRMADO`)                                                                    | notification (recibo), rating (futuro), payout F5  |
| `booking.started`   | PublishedTrip → `EN_RUTA`                                                                                                        | **trip-service** → crea el `Trip` en vivo (§9, F4) |
| `booking.completed` | viaje termina                                                                                                                    | rating, payout F5                                  |
| `booking.cancelled` | cancelación (con `tier`) **o** cobro fallido / asiento-lleno                                                                     | **payment-service** → gestiona el `Refund`         |

### 7.1.bis Eventos CONSUMIDOS de payment-service (el cobro asíncrono)

El cobro NO se lee en línea: booking **reacciona a los eventos** que payment-service emite cuando el webhook/poll
resuelve la captura. Son los reales de payment-service — no se inventan.

| Evento consumido   | De                                                 | Qué gatilla en booking                                                                                |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `payment.captured` | payment-service (webhook/poll resolvió la captura) | corre la txn atómica del §6: `COBRO_PENDIENTE → CONFIRMADO` (o Refund si el asiento ya se llenó)      |
| `payment.failed`   | payment-service (riel rechazó / timeout)           | BR-P02: reintento (máx 3) → falla perm. → Booking `CANCELADO`; deuda derivada de `PaymentStatus.DEBT` |

### 7.2 gRPC

| Dirección   | Método                     | Para qué                                                                                                                                                                                                  |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consume** | `identity.GetDriver`       | re-validar elegibilidad del conductor **antes** de publicar/aprobar: **suspensión** al publicar/rechazar; **FULL** (suspensión + KYC + antecedentes) al **aprobar** (mueve plata, ver §8)                 |
| **Consume** | `payment.GetPayment`       | validar método al RESERVAR + leer estado/recibo (`PENDING` → `[CAPTURED, FAILED, DEBT]`) + derivar el gate de deuda (`PaymentStatus.DEBT`). La CAPTURA NO se lee acá: llega por evento `payment.captured` |
| **Expone**  | `booking.GetPublishedTrip` | para trip-service / admin                                                                                                                                                                                 |
| **Expone**  | `booking.GetBooking`       | para trip-service / admin                                                                                                                                                                                 |

---

## 8. Acceso (la UI nunca autoriza) — endpoint × riel × rol

Cada endpoint declara su **riel** vía `InternalIdentityGuard` + `@Audiences(InternalAudience.X)` (mismo patrón
ya scopeado en identity). Conductor publica/aprueba → `driver-rail`; pasajero busca/reserva → `public-rail`;
admin override → `admin-rail`. Gate **server-side** (4 capas: guard → service re-valida → DB).

| Capacidad                          | Endpoint (forma)                           | Riel          | Rol       | Regla server-side                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------ | ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publicar viaje                     | `POST /published-trips`                    | `driver-rail` | conductor | `GetDriver` no suspendido + `pricingMode=FIJO`                                                                                                                                                                                                                                                                                                 |
| Editar/cancelar publicación        | `PATCH/DELETE /published-trips/:id`        | `driver-rail` | conductor | dueño del `PublishedTrip`                                                                                                                                                                                                                                                                                                                      |
| Buscar viajes                      | `GET /published-trips?ruta&fecha&asientos` | `public-rail` | pasajero  | solo `PUBLICADO`/`PARCIALMENTE_RESERVADO`                                                                                                                                                                                                                                                                                                      |
| Ver detalle                        | `GET /published-trips/:id`                 | `public-rail` | pasajero  | público de los publicados                                                                                                                                                                                                                                                                                                                      |
| Reservar                           | `POST /bookings`                           | `public-rail` | pasajero  | valida método de pago (§5); asientos ≤ disponibles                                                                                                                                                                                                                                                                                             |
| Cancelar reserva                   | `DELETE /bookings/:id`                     | `public-rail` | pasajero  | dueño del `Booking` → Refund por tier                                                                                                                                                                                                                                                                                                          |
| Ver mis reservas                   | `GET /bookings/mine`                       | `public-rail` | pasajero  | solo SUS `passengerId` (no IDOR)                                                                                                                                                                                                                                                                                                               |
| Aprobar/rechazar solicitud         | `POST /bookings/:id/{approve,reject}`      | `driver-rail` | conductor | dueño del `PublishedTrip`. **APROBAR** (mueve plata) re-valida **elegibilidad FULL** (`isDriverEligible`: suspensión + KYC + antecedentes) **+ vehículo operable** (`isVehicleOperable`: SOAT/ITV + ficha) → dispara CHARGE (async) → `COBRO_PENDIENTE`. **RECHAZAR** (no mueve plata) solo exige no-suspendido (`isDriverActive`). Ver nota ⬇ |
| Ver solicitudes de mi viaje        | `GET /published-trips/:id/bookings`        | `driver-rail` | conductor | dueño del `PublishedTrip`                                                                                                                                                                                                                                                                                                                      |
| Override (forzar estado, cancelar) | `POST /admin/...`                          | `admin-rail`  | admin     | auditado                                                                                                                                                                                                                                                                                                                                       |

> ⚠️ **ENMENDADO por el Lote 3 (match-chain · commit `ab60dc9`, 2026-06-29):** el gate de **aprobar** NO es
> "solo suspensión" como decía la versión original de esta tabla (§7.2/§9 también). El gate de match (conductor
> elegible + vehículo operable) era **one-shot al publicar**, pero la operabilidad es **derivada** (SOAT/ITV + ficha)
> y **FLIPEA** después de publicar; y `kycStatus`/`backgroundCheckStatus` pueden caer a `REJECTED` en un conductor
> que NO está suspendido. Como **aprobar dispara el CHARGE (mueve plata)**, debe re-validar la elegibilidad **FULL**
> (`isDriverEligible`) **+ la operabilidad del vehículo** (`isVehicleOperable`), no solo la suspensión. **Rechazar**
> (no mueve plata) se queda en el gate laxo `isDriverActive` (solo suspensión sobreviniente). La misma re-validación
> FULL fail-closed aplica a **reservar** (INSTANT cobra al instante) y al **detalle**; la **búsqueda** la hace
> best-effort (display, no mueve plata). Verificado por 3 gates adversariales (`auditar-core`): cero hueco de dinero.

---

## 9. Integración con servicios existentes (qué reusa, por evento/gRPC)

| Servicio             | Cómo se integra                                                                                                                                                                             | Qué reusa                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **payment-service**  | CHARGE async con `dedupKey` (§5) · **consume `payment.captured`/`payment.failed`** · gRPC `GetPayment` (validar al reservar + derivar gate `DEBT`) · consume `booking.cancelled` → `Refund` | el CHARGE `PENDING → [CAPTURED, FAILED, DEBT]` (asíncrono, captura por webhook), el `Refund` y la política de deuda `DEBT` (NO tabla propia, NO flag DEBT propio, NO estado HOLD) |
| **identity-service** | gRPC `GetDriver` (re-validar elegibilidad: suspensión al publicar/rechazar, FULL al aprobar — §8)                                                                                           | la identidad/estado del conductor                                                                                                                                                 |
| **trip-service**     | consume `booking.started` → crea el `Trip` en vivo                                                                                                                                          | la fundación de seguridad (cámara/pánico/familia/modo niño) ya construida                                                                                                         |
| **places-service**   | gRPC para enriquecer (geocoding/rutas) al publicar/mostrar                                                                                                                                  | geocoding/rutas — **NO busca viajes** (no es su dominio)                                                                                                                          |
| **rating-service**   | consume `booking.completed` (F5)                                                                                                                                                            | el rating post-viaje existente                                                                                                                                                    |

> **Búsqueda geo**: índice **propio en booking-service (H3, como dispatch — ADR 008)**. `places-service` solo
> enriquece (geocoding/rutas), **no busca viajes**. La búsqueda ruta+fecha+#asientos es del dominio booking.

---

## 10. Caminos infelices (PLAYBOOK §5.3) — el "¿y si…?"

| ¿Y si…?                                                 | Resultado de diseño                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| el conductor no responde la solicitud                   | TTL ~5min vence → Booking `EXPIRADO` (`booking.expired`). **No se cobró nada** (charge-on-approval).                                                                                                                                                                                                                                     |
| el pasajero cancela                                     | Booking `CANCELADO` → `booking.cancelled` con **tier de antelación** → payment-service gestiona el `Refund`.                                                                                                                                                                                                                             |
| el cobro (async) falla tras aprobar                     | llega `payment.failed` → BR-P02: reintento (máx 3, idempotente por `dedupKey`). Falla permanente → `CANCELADO`; el gate de "no puede reservar" se **DERIVA de `PaymentStatus.DEBT`** de payment-service (booking NO tiene flag propio). Asiento no se perdió (solo decrementa al capturar).                                              |
| N pasajeros con el cobro EN VUELO por el ÚLTIMO asiento | con cobro async, varios pueden estar en `COBRO_PENDIENTE` a la vez. **lock atómico** (§6) en el handler de `payment.captured`: el 1º en capturar gana y decrementa; el 2º re-lee, no alcanza → **NO se aborta sin más (su dinero YA capturó)** → **Refund automático** (`booking.cancelled` reason=`asiento-lleno`). **Nunca oversold.** |
| conductor SUSPENDIDO intenta publicar/aprobar           | `GetDriver` (gRPC) en el service (capa 2/3, no solo guard) → **403**. La UI nunca autoriza.                                                                                                                                                                                                                                              |
| Instant Booking sin aprobación                          | el Booking nace `APROBADO` (salta `PENDIENTE_APROBACION`) → el CHARGE se dispara igual → `COBRO_PENDIENTE` hasta `payment.captured`.                                                                                                                                                                                                     |
| doble-tap del conductor al aprobar                      | idempotente: `assertTransition` rechaza el 2º `PENDIENTE_APROBACION→APROBADO`; el CHARGE lleva `dedupKey` → no duplica.                                                                                                                                                                                                                  |

---

## 11. Consecuencias + qué se difiere

### 11.1 Positivas

- **Bounded context limpio**: el marketplace no contamina `trip-service`; cada uno evoluciona a su ritmo.
- **`payment-service` intacto**: charge-on-approval encaja con su flujo real `PENDING → [CAPTURED, FAILED, DEBT]` (captura asíncrona por webhook) y con Yape/Plin sin inventar HOLD ni replicar su `DEBT`.
- **Cero strings mágicos**: enums tipados (incl. `COBRO_PENDIENTE`) + `assertTransition` → las transiciones ilegales son imposibles, no "un bug".
- **Una sola fuente de verdad del cobro**: el estado del dinero y la deuda viven en payment-service; booking los consume por evento y deriva el gate, sin flag DEBT paralelo.
- **Sin oversold by design**: el lock atómico sobre `asientosDisponibles` es la única fuente de verdad del cupo.
- **Reuso por contrato**: Refund, identidad, viaje-en-vivo, rating se reusan por evento/gRPC, sin acoplar tablas.

### 11.2 Negativas / costo

- **Garantía de cobro más débil que un hold**: se mitiga (validar al reservar + reintento + `DEBT` derivado de
  payment-service), pero el riesgo de "aprobé y no pude cobrar" existe → el `DEBT` es el backstop, no una garantía perfecta.
- **Ventana de cobro asíncrona**: la captura llega minutos después por webhook/poll, no en línea. Eso obliga al
  estado intermedio `COBRO_PENDIENTE` y abre el camino infeliz "cobré pero el asiento se llenó → Refund automático"
  (§6) — varios pasajeros pueden tener el cobro en vuelo por el último asiento; el 1º en capturar gana, el resto se reembolsa.
- **Un servicio más** que operar (puerto 3016/50054, schema, deploy, observabilidad).
- **Handoff a trip-service** (`booking.started`) introduce un punto de coordinación entre marketplace y viaje vivo.

### 11.3 Diferido a fases futuras (degradación honesta — `specs §11`)

| Diferido                                                     | Fase   | Por qué fuera de este ADR                                                                          |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| **PUJA** (`pricingMode=PUJA`, contraoferta bidireccional)    | **F6** | este ADR es FIJO; PUJA es otro modelo (ver ADR 010 para el patrón de puja del carril AHORA)        |
| **Multi-pasajero del viaje EN VIVO** (N bookings en un Trip) | **F4** | lo EJECUTA trip-service; acá se deja como dirección (`booking.started`), no se resuelve al detalle |
| **Payout al conductor**                                      | **F5** | consume `booking.completed`; fuera del cimiento transaccional                                      |
| **Ecuador / multipaís** (cédula EC, rails de pago EC)        | **F8** | este ADR es `pais=PE`, `moneda=PEN`; la capa país es transversal posterior                         |

---

## 12. Puerto + anatomía del servicio

- **Puerto REST**: **3016** · **gRPC**: **50054** (próximos libres verificados; registrar en `REGISTRO-PUERTOS.md` + env).
- **Schema Postgres**: lógico `booking` (DB-per-service; no comparte tablas).

**Anatomía AS-BUILT (F0).** Convención NestJS: módulos en PLURAL (`published-trips/`, `bookings/`), un módulo
Nest por agregado (controller + service + repository + dto). Las máquinas de estado viven en `domain/` (no
inline en cada módulo), el outbox-relay e infra compartida en `infra/`, y los guards de riel se cablean inline
en `infra/core.module.ts` (`InternalIdentityGuard` + `AudienceGuard` de `@veo/auth`, no una carpeta `rails/`).
Lo marcado `(F1-F3)` aún NO existe (degradación honesta): se agrega en su fase.

```
booking-service/
├── src/
│   ├── published-trips/                       # módulo Nest (la OFERTA) — PLURAL
│   │   ├── published-trips.controller.ts      # POST /published-trips (driver) · GET /:id (public)
│   │   ├── published-trips.service.ts         # orquesta publicar; emite booking.published (outbox)
│   │   ├── published-trips.repository.ts      # Prisma, schema booking (outbox-in-transaction)
│   │   ├── published-trips.module.ts
│   │   └── dto/create-published-trip.dto.ts   # endurecimiento del borde (class-validator)
│   ├── bookings/                              # módulo Nest (la RESERVA) — PLURAL
│   │   ├── bookings.controller.ts             # POST /bookings · GET /:id (ownership server-side, anti-IDOR)
│   │   ├── bookings.service.ts                # reservar; evento por estado real (requested/approved)
│   │   ├── bookings.repository.ts             # outbox-in-transaction + idempotencia de request (P2002→existente)
│   │   ├── bookings.module.ts
│   │   └── dto/create-booking.dto.ts
│   │   # payment-event.handler.ts (consume payment.captured/failed → txn atómica §6 / BR-P02)  ← F3
│   ├── domain/                                # máquinas de estado TIPADAS (no inline en los módulos)
│   │   ├── booking-state.ts                   # BookingState (+COBRO_PENDIENTE) + assertTransition
│   │   ├── published-trip-state.ts            # PublishedTripState + assertTransition
│   │   └── state-machine.ts                   # assertTransition genérico (Record<Estado, Estado[]>)
│   ├── events/
│   │   └── booking-events.ts                  # lista TIPADA de eventos emitidos, topic 'booking'
│   ├── infra/                                 # singletons compartidos
│   │   ├── core.module.ts                     # Prisma + Redis + guards de riel inline (InternalIdentityGuard + AudienceGuard) + CLOCK + outbox relay
│   │   ├── prisma.service.ts                  # read/write split
│   │   ├── outbox.relay.ts                    # outbox → Kafka (topic 'booking')
│   │   └── redis.ts
│   ├── config/env.schema.ts                   # validación Zod del entorno (fail-fast al boot)
│   ├── common/health.controller.ts
│   ├── app.module.ts
│   └── main.ts                                # bootstrap (usa el PORT/GRPC_URL ya validados por Zod, no process.env crudo)
│   # geo/geo-index.service.ts (índice H3, búsqueda ruta+fecha)                                   ← F2
│   # ports/{payment,identity}/ (gRPC GetPayment/GetDriver + CHARGE async, dedupKey; deuda DERIVADA) ← F1/F3
│   # grpc/ (expone GetPublishedTrip, GetBooking)                                                  ← F2+
└── prisma/
    └── schema.prisma                          # schema 'booking' (PublishedTrip, Booking, OutboxEvent)
```

---

_Decisión: `booking-service` NUEVO (no extender trip), dueño de PublishedTrip+Booking, cobro
**charge-on-approval SIN hold** (mecanismo **asíncrono**: CHARGE → `COBRO_PENDIENTE` → evento `payment.captured` →
`CONFIRMADO`; deuda derivada de payment-service, no flag propio), asientos con lock atómico en el handler de captura
(camino infeliz asiento-lleno → Refund), eventos por outbox, rieles server-side.
Reusa payment/identity/trip/places/rating por evento/gRPC. PUJA(F6)/multi-pax-vivo(F4)/payout(F5)/EC(F8)
quedan fuera de scope. Próximo: F0 cimiento de datos → F1 publicar → /abordar por lotes._
