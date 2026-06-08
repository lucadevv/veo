# Eventos de `trip-service`

Todos los eventos se publican vía **outbox** (misma transacción que la mutación de dominio) y un
relay los drena a Kafka cada 500ms. Topic = dominio antes del punto (`trip`, `dispatch`). Key = `tripId`.

## Publica (topic `trip`)

| eventType | Schema (`@veo/events`) | Disparado por | Payload |
|---|---|---|---|
| `trip.requested` | `EVENT_SCHEMAS['trip.requested']` | `POST /trips` | `{ tripId, passengerId, origin, destination, fareCents, childMode }` |
| `trip.assigned` | `EVENT_SCHEMAS['trip.assigned']` | `assign` / `dispatch.match_found` | `{ tripId, driverId, vehicleId }` |
| `trip.accepted` | `EVENT_SCHEMAS['trip.accepted']` | `POST /trips/:id/accept` | `{ tripId, driverId, etaSeconds }` |
| `trip.arriving` | `EVENT_SCHEMAS['trip.arriving']` | `POST /trips/:id/arriving` | `{ tripId, driverId, etaSeconds, at }` |
| `trip.arrived` | `EVENT_SCHEMAS['trip.arrived']` | `POST /trips/:id/arrived` | `{ tripId, driverId, at }` |
| `trip.started` | `EVENT_SCHEMAS['trip.started']` | `POST /trips/:id/start` | `{ tripId, driverId, startedAt }` |
| `trip.completed` | `EVENT_SCHEMAS['trip.completed']` | `POST /trips/:id/complete` | `{ tripId, fareCents, distanceMeters, durationSeconds }` |
| `trip.cancelled` | `EVENT_SCHEMAS['trip.cancelled']` | `POST /trips/:id/cancel` | `{ tripId, by, reason?, penaltyCents }` |
| `trip.child_code_failed` | ⚠️ **sin schema registrado** | `start` con código niño incorrecto (BR-T07) | `{ tripId, passengerId, driverId, at }` |

> `trip.child_code_failed` aún **no** existe en `EVENT_SCHEMAS`. Se publica sin validación de
> registro (alerta de seguridad para notification/panic). Ver "Contratos pendientes".

## Consume

| Topic | eventType | Schema | Acción | Reintentos |
|---|---|---|---|---|
| `dispatch` | `dispatch.match_found` | `EVENT_SCHEMAS['dispatch.match_found']` | Transición a **ASSIGNED** (asigna conductor) | kafkajs (8) |

Group id: `trip-service.dispatch`. Idempotente: si el viaje ya está `ASSIGNED` con el mismo
conductor, se ignora el reproceso.

## Contratos pendientes (compartidos en `@veo/events`)

1. **`trip.child_code_failed`** — falta registrar el schema Zod en `EVENT_SCHEMAS` para que los
   consumidores (notification/panic) validen el payload `{ tripId, passengerId, driverId, at }`.
2. **`dispatch.match_found` sin `vehicleId`** — el schema actual es `{ tripId, driverId, scoreMs }`.
   Al asignar desde dispatch no hay `vehicleId`, por lo que `trip.assigned` se emite con
   `vehicleId: ''`. Conviene añadir `vehicleId` a `dispatch.match_found` para cerrar el dato.
