# booking-service · eventos

Todos los eventos de dominio van por el **outbox pattern** (FOUNDATION §6 / ADR-014 §7): la mutación y el
`INSERT` del evento ocurren en la **MISMA transacción** Prisma. El `OutboxRelay` (`@veo/database`) drena la
tabla `outbox_events` y publica al **topic Kafka `booking`** con `key = aggregateId` (ordena por entidad).

El **contrato** de cada payload (schema Zod) vive en `@veo/events` (`EVENT_SCHEMAS`) para que los
consumidores validen lo que reciben. Acá `events/booking-events.ts` solo centraliza la lista tipada
(`BookingEventType.X`, cero strings mágicos). Productor (`producer` del envelope): `booking-service`.

Envelope estándar (`@veo/events`): `{ eventId (UUIDv7), eventType, producer, occurredAt, payload }`.

---

## Eventos emitidos (F0)

### `booking.published`
Se publicó un `PublishedTrip` (la **oferta** del conductor: `BORRADOR → PUBLICADO`).

- **Topic**: `booking` · **key**: `publishedTripId`
- **Payload**:

| campo | tipo | nota |
|-------|------|------|
| `publishedTripId` | string (UUID) | id de la oferta |
| `driverId` | string (UUID) | server-truth (identidad firmada) |
| `vehicleId` | string (UUID) | |
| `asientosTotales` | int | |
| `precioBase` | int | céntimos PEN |
| `modoReserva` | `'INSTANT_BOOKING' \| 'REVISION_CADA_SOLICITUD'` | |
| `fechaHoraSalida` | string (ISO) | salida futura |
| `pais` | string | `PE` en F0 (EC → F8) |
| `moneda` | string | `PEN` |

### `booking.requested`
Se creó un `Booking` en modo **REVISION** (`→ PENDIENTE_APROBACION`, espera al conductor). SOLO se emite en
`REVISION_CADA_SOLICITUD`; en INSTANT el Booking nace APROBADO y emite `booking.approved`.

- **Topic**: `booking` · **key**: `bookingId`
- **Payload**:

| campo | tipo | nota |
|-------|------|------|
| `bookingId` | string (UUID) | |
| `publishedTripId` | string (UUID) | |
| `passengerId` | string (UUID) | server-truth (identidad firmada, anti-IDOR) |
| `driverId` | string (UUID) | dueño de la oferta |
| `asientos` | int | |
| `precioAcordado` | int | céntimos PEN = `precioBase + specialRequest` |
| `modoReserva` | `'REVISION_CADA_SOLICITUD'` | literal |
| `estado` | `'PENDIENTE_APROBACION'` | literal |

### `booking.approved`
El `Booking` quedó **APROBADO**. En F0 solo el caso **INSTANT** (el booking nace APROBADO al reservar, salta
`PENDIENTE_APROBACION`, §4.2). El caso "el conductor aprueba" (`origen: 'APROBACION_CONDUCTOR'`) es F1.

- **Topic**: `booking` · **key**: `bookingId`
- **Payload**:

| campo | tipo | nota |
|-------|------|------|
| `bookingId` | string (UUID) | |
| `publishedTripId` | string (UUID) | |
| `passengerId` | string (UUID) | server-truth |
| `driverId` | string (UUID) | |
| `asientos` | int | |
| `precioAcordado` | int | céntimos PEN |
| `modoReserva` | `'INSTANT_BOOKING' \| 'REVISION_CADA_SOLICITUD'` | |
| `estado` | `'APROBADO'` | literal |
| `origen` | `'INSTANT_BOOKING' \| 'APROBACION_CONDUCTOR'` | F0 emite `INSTANT_BOOKING` |

> El evento refleja el **estado real**: emitir `booking.requested` en INSTANT (que el ADR mapea a
> "→ PENDIENTE_APROBACION") sería semánticamente falso, por eso INSTANT emite `booking.approved`.

---

## Eventos declarados, emisión diferida

Están en el registro (`@veo/events` y `events/booking-events.ts`) para que el contrato exista, pero su
**emisión** vive en la fase que la gatilla (degradación honesta):

| evento | gatillo | fase |
|--------|---------|------|
| `booking.rejected` | el conductor rechaza la solicitud | F1 |
| `booking.expired` | TTL ~5 min sin respuesta → EXPIRADO | F1 |
| `booking.confirmed` | se consume `payment.captured` → CONFIRMADO | F3 |
| `booking.started` | `PublishedTrip → EN_RUTA` (trip-service crea el Trip en vivo) | F4 |
| `booking.completed` | el viaje terminó | F4/F5 |
| `booking.cancelled` | cancelación (con tier) o cobro fallido / asiento-lleno → Refund | F3/F5 |

---

## Eventos consumidos (diferido a F3)

F0 **no consume** ningún evento. El consumo está diferido:

- `payment.captured` → `CONFIRMADO` (CHARGE async) + decremento atómico de `asientosDisponibles` (lock §6) — **F3**.
- El wiring del consumer Kafka (`@veo/events` `KafkaConsumerBootstrap`) se cablea en la fase que lo necesita;
  en F0 el servicio solo **produce** (vía outbox), no se suscribe a ningún topic.
