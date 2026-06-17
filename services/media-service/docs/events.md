# Eventos de `media-service`

Bus: Kafka (`localhost:9094` en dev). Patrón **outbox** (FOUNDATION §6): la mutación de dominio y
el insert del evento ocurren en la misma transacción Postgres; el `OutboxRelay` drena cada 500 ms.
Topic Kafka = dominio antes del punto (`media`, `trip`, `panic`). Key = `tripId` (orden por viaje).

## Publica

| Evento (topic `media`)               | Schema (payload)                                                                                    | Disparado por                                    | Consumidores                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| `media.recording_started`            | `{ tripId, roomName, startedAt }`                                                                   | `trip.started` / force-start por pánico (BR-S01) | audit, compliance                      |
| `media.archived`                     | `{ tripId, s3Key, bytes, retentionDays }` (`retentionDays = -1` ⇒ indefinido por pánico)            | `trip.completed` (BR-S01)                        | audit, billing-compliance              |
| `media.access_granted` _(propuesto)_ | `{ requestId, tripId, segmentId, operatorId, operatorEmail, approvedBy, watermark, expiresAt, at }` | aprobación de acceso a video (BR-S02)            | **audit-service** (cadena de custodia) |

> `media.recording_started` y `media.archived` ya están en `EVENT_SCHEMAS` de `@veo/events` y se
> validan al publicar. `media.access_granted` **aún no está registrado**: se publica igual (el
> productor solo valida si existe schema), pero **debe añadirse al contrato compartido** para que
> `audit-service` lo valide al consumir. Ver propuesta abajo.

## Consume

| Evento            | Schema                                                         | Acción                                                                                                                  | Idempotencia                                                       |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `trip.started`    | `{ tripId, driverId, startedAt }`                              | Inicia grabación LiveKit + crea segmento + publica `media.recording_started` (BR-S01)                                   | dedup por `eventId` (Redis 24h) + segmento abierto único por viaje |
| `trip.completed`  | `{ tripId, fareCents, distanceMeters, durationSeconds }`       | Detiene egress + finaliza segmento + publica `media.archived` (BR-S01)                                                  | dedup por `eventId`; no-op si no hay segmento abierto              |
| `panic.triggered` | `{ panicId, tripId, passengerId, geo, dedupKey, triggeredAt }` | **Force-start** de grabación aunque el viaje no esté IN_PROGRESS + retención **indefinida** (BR-S01 excepción / BR-S03) | dedup por `eventId`; si ya graba, solo escala la retención         |

## Propuesta de contrato compartido (`@veo/events`)

Para cerrar la auditoría del acceso a video (BR-S02) se propone registrar en `EVENT_SCHEMAS`:

```ts
export const mediaAccessGranted = z.object({
  requestId: z.string(),
  tripId: z.string(),
  segmentId: z.string(),
  operatorId: z.string(),
  operatorEmail: z.string().email(),
  approvedBy: z.string(),
  watermark: z.string(),
  expiresAt: z.string(),
  at: z.string(),
});
// EVENT_SCHEMAS['media.access_granted'] = mediaAccessGranted;
```
