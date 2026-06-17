# Eventos de `share-service`

## Publica (vía outbox → Kafka)

| eventType              | Topic   | Schema (`@veo/events`)           | Disparado por                                                              | Consumidores                         |
| ---------------------- | ------- | -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `share.link_generated` | `share` | `{ shareId, tripId, expiresAt }` | Creación de enlace (REST `POST /share/:tripId`) y flujo de pánico (BR-S05) | notification-service, audit-service  |
| `share.viewed`         | `share` | `{ shareId, at }`                | Apertura de la página pública `GET /public/share/:token`                   | audit-service, trip/safety analytics |

## Consume

| eventType         | Topic   | Acción                                                                                                                                                                                                       | Reintentos                                                     |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `trip.started`    | `trip`  | Actualiza el read-model `trip_snapshots` (estado `IN_PROGRESS`, driver, inicio)                                                                                                                              | Reintento del consumer group (offset no commiteado ante error) |
| `panic.triggered` | `panic` | BR-S05: guarda ubicación aproximada en `trip_snapshots`, genera enlaces de seguimiento para los contactos de confianza verificados del pasajero, publica `share.link_generated` y envía el SMS con el enlace | Reintento del consumer group                                   |

## Garantías

- **Outbox transaccional** (FOUNDATION §6): el `share.link_generated`/`share.viewed` se inserta en la
  MISMA transacción Postgres que la mutación de dominio (`enqueueOutbox`). El `OutboxRelay` (cada 500ms)
  drena con `drainOutbox` + `PrismaOutboxStore` y publica a Kafka. Republicar es idempotente.
- **Validación**: `KafkaEventConsumer` valida el payload contra `EVENT_SCHEMAS` al recibir y descarta lo
  inválido; `KafkaEventProducer.publish` valida antes de enviar.

## Necesidad de contrato compartido NO cubierta

> El schema `share.link_generated = { shareId, tripId, expiresAt }` (en `@veo/events`, paquete dist, no
> editable) **no transporta el token** del enlace. El token es secreto y solo se guarda su `sha256`.
> Por eso, en el flujo de pánico, `share-service` envía el SMS con el enlace **directamente por su puerto
> SMS** (además de publicar `share.link_generated` para audit/notification).
>
> Si se requiere que `notification-service` sea el único emisor del SMS con el enlace, el contrato
> `share.link_generated` debe ampliarse con una referencia de entrega (p. ej. el token firmado o una URL
> de un solo uso) o exponerse un endpoint/gRPC de "resolución de enlace" para notification-service.
