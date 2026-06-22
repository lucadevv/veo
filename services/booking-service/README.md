# booking-service

Dueño del **marketplace de carpooling PROGRAMADO** de VEO (ADR-014): la **oferta** del conductor
(`PublishedTrip`) y la **reserva** del pasajero (`Booking`). DB-per-service (schema lógico `booking`),
NO comparte tablas con trip/payment/identity/fleet — las relaciones cross-service son por ID
(`driverId`/`vehicleId`/`passengerId`/`paymentId`), nunca FK cross-schema. Dinero siempre en céntimos
(Int), moneda PEN. IDs UUIDv7 generados por la app.

- **Puertos** (ADR-014 §12): REST `3016`, gRPC `50054` (reservado, ver §gRPC).
- **Prefijo REST**: `api/v1`. `health`/`health/ready`/`metrics` quedan FUERA del prefijo (sondas de orquestador y BFF).

## Qué hace (alcance F0)

Este servicio en F0 cubre el **camino feliz de publicar y reservar**:

- El **conductor publica** una oferta (`BORRADOR → PUBLICADO` en el mismo acto, validado por la máquina de estados tipada).
- El **pasajero reserva** un asiento. El estado inicial del booking lo decide el `modoReserva` de la oferta:
  - `REVISION_CADA_SOLICITUD` → `SOLICITADO → PENDIENTE_APROBACION` (espera la aprobación del conductor).
  - `INSTANT_BOOKING` → `SOLICITADO → APROBADO` (salta `PENDIENTE_APROBACION`, ADR-014 §4.2).
- Cada mutación de dominio emite su evento en la **MISMA transacción** (outbox pattern, FOUNDATION §6).

## Endpoints REST (acceso por riel server-side)

El acceso lo gobierna el server, nunca la UI: `InternalIdentityGuard` valida la identidad firmada (HMAC)
que el BFF propaga + `AudienceGuard` exige el riel declarado por `@Audiences` (fail-closed, por handler).
`driverId`/`passengerId` salen de la **identidad firmada** (server-truth), **nunca del body ni del path**
(anti-IDOR por construcción).

| Método | Ruta | Riel | Descripción |
|--------|------|------|-------------|
| `POST` | `/api/v1/published-trips` | driver-rail | El conductor publica una oferta (`BORRADOR → PUBLICADO`). |
| `GET`  | `/api/v1/published-trips/:id` | public-rail | Ver el detalle de un viaje publicado (listado público del marketplace). |
| `POST` | `/api/v1/bookings` | public-rail | El pasajero reserva un asiento. Idempotente vía header `Idempotency-Key`. |
| `GET`  | `/api/v1/bookings/:id` | public-rail | El pasajero ve **su** reserva (solo si es el dueño; si no → 404, no se filtra existencia). |

### Idempotencia de la reserva (`POST /bookings`)

La idempotencia de **request** se ancla en el header `Idempotency-Key` (UUID por intento de submit),
**no** en `passenger × trip` (no hay lockout: tras un terminal alcanzable el re-booking funciona).

- La `dedupKey` persistida = `booking:req:{passengerId}:{Idempotency-Key}` — **scopeada por el `passengerId`
  server-truth** (anti-IDOR cross-tenant): dos pasajeros distintos con el MISMO header derivan dedupKeys
  DISTINTAS → nunca colisionan → un pasajero jamás recupera la reserva (ni la PII) de otro.
- Reintento del MISMO submit (misma key, mismo pasajero) → `P2002` → se devuelve el booking ya creado
  (recuperado del **primary** para no perderlo por lag de réplica). Cinturón + tiradores: la recovery
  re-verifica `existing.passengerId === expectedPassengerId` antes de devolver — si no coincide (no debería
  pasar nunca con el namespace), error tipado, nunca la fila ajena.
- Sin header: se genera una key única server-side (igual namespaceada por `passengerId`) → no lockea, pero
  tampoco dedupea (el retry-safe real exige que el cliente mande el header). Header malformado → `ValidationError`.

> La idempotencia **financiera** del CHARGE (F3) es otra cosa: se deriva del `bookingId` (per-booking), no de esta key.

## Eventos emitidos

Outbox → topic Kafka `booking`. Detalle de payloads/topics en [`docs/events.md`](./docs/events.md).

- `booking.published` — se publicó un `PublishedTrip` (oferta del conductor).
- `booking.requested` — se creó un `Booking` en modo REVISION (`→ PENDIENTE_APROBACION`).
- `booking.approved` — se creó un `Booking` en modo INSTANT (nace `APROBADO`).

El resto de eventos del ADR-014 §7.1 (`rejected`/`expired`/`confirmed`/`started`/`completed`/`cancelled`)
se **declaran** (en `events/booking-events.ts` y `@veo/events`) pero su **emisión se difiere** a la fase
que la gatilla (F1–F5).

## Readiness (`GET /health/ready`)

Verifica las dependencias **duras** de F0: **postgres** (`SELECT 1`), **kafka** (`describeCluster` vía un
Admin dedicado — el OutboxRelay drena al topic `booking`, sin broker los eventos no salen) y **redis**
(`PING` — cliente compartido cableado en `CoreModule`).

## Diferido a fases futuras (degradación honesta, ADR-014)

| Tema | Fase |
|------|------|
| Gate gRPC `identity.GetDriver` (conductor no suspendido antes de publicar/aprobar) | F1 |
| Aprobar/rechazar reserva (`POST /bookings/:id/{approve,reject}`, driver-rail) + TTL → EXPIRADO | F1 |
| "Ver MIS reservas" (`GET /bookings/mine`) + listado de solicitudes del conductor | F1 |
| Búsqueda geo (índice H3, `GET /published-trips?ruta&fecha`) | F2 |
| Pricing por tramo (`precioPorTramo` según pickup/dropoff) + stopovers ricos | F1 |
| Validación del método de pago al reservar + gate de deuda (`PaymentStatus.DEBT`) | F1/F3 |
| CHARGE async (`COBRO_PENDIENTE → CONFIRMADO`) consumiendo `payment.captured` + lock atómico de asientos (§6) | F3 |
| Cancelar (`DELETE /bookings/:id` → Refund por tier) | F3 |
| Servidor gRPC `booking.GetPublishedTrip`/`GetBooking` (`proto/booking.proto`) | F2 |
| EC (multipaís) | F8 |

> En F0 `asientosDisponibles` **no** decrementa al reservar: el decremento ocurre al CONFIRMAR (handler de
> `payment.captured`, §6, F3). El chequeo de cupo en F0 es barato (no transaccional); la garantía dura
> contra overbooking concurrente llega con el lock en F3.

## Desarrollo

```bash
pnpm --filter @veo/booking-service dev         # levantar el servicio
pnpm --filter @veo/booking-service test        # vitest
pnpm --filter @veo/booking-service typecheck   # tsc --noEmit
```
