# Eventos de `rating-service`

Todos los eventos publicados salen por el **patrón outbox** (FOUNDATION §6): se insertan en
`rating.outbox_events` dentro de la misma transacción que la mutación de dominio, y un relay
(`OutboxRelay`, cada 500 ms) los publica a Kafka marcando `published_at`. La `key` de Kafka es el
`aggregateId` (id del sujeto), para preservar el orden por entidad.

## Publica

| Topic | eventType | Payload (schema) | Disparado por | Consumidores previstos |
|---|---|---|---|---|
| `rating` | `rating.created` | `{ ratingId, tripId, driverId, stars }` | `POST /ratings` (cada calificación creada) | identity/dispatch (rating del conductor), analítica |
| `driver` | `driver.flagged` | `{ driverId, rollingAvg, reason }` | Transición a flag del conductor (BR-D01) | identity-service (review/suspensión), panel admin |
| `passenger` | `passenger.flagged` | `{ passengerId, rollingAvg, reason }` | Transición a flag del pasajero (BR-I05) | identity-service (re-verificación) |

Notas de contrato:

- `rating.created` está registrado en `@veo/events` (`EVENT_SCHEMAS['rating.created']`) y su payload se
  valida antes de publicar. El campo `driverId` del contrato transporta el **id del sujeto calificado**
  (`ratedId`), sea conductor o pasajero, ya que el contrato actual no tiene un campo genérico de rol.
- `driver.flagged` está registrado y validado.
- `passenger.flagged` **NO está aún en `EVENT_SCHEMAS`** de `@veo/events`. Se publica igualmente (sin
  validación de payload) para no bloquear BR-I05, pero **debe añadirse al contrato compartido**
  (ver README → "Necesidades de contrato compartido").
- `reason` ∈ `{ "review", "suspension", "reverification" }`.
- Los eventos de flag se emiten **solo en la transición** a un (nuevo) estado/razón de flag, no en cada
  recálculo, para evitar duplicados/ruido.

## Consume

| Topic | eventType | Acción | Reintentos |
|---|---|---|---|
| `trip` | `trip.completed` | Marca el viaje como elegible para calificación (gate post-viaje). | Consumidor con arranque resiliente (reintenta cada 5 s si el topic/broker no está listo). Offsets gestionados por el group `rating-service`. |

Nota: el payload actual de `trip.completed` (`{ tripId, fareCents, distanceMeters, durationSeconds }`)
no incluye `driverId`/`passengerId`, por lo que el servicio no puede pre-poblar quién califica a quién;
el `POST /ratings` recibe `ratedId` y `ratedRole` del llamante (BFF).
