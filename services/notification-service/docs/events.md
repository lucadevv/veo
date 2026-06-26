# Eventos de `notification-service`

El motor publica resultados de entrega vía **OUTBOX → Kafka** y consume eventos de dominio para
disparar notificaciones reales. Todos los payloads usan el envelope de `@veo/events`.

## Publica (vía outbox)

| Topic / eventType     | Schema (`EVENT_SCHEMAS`)             | Disparado por                                                                                                                                            | Consumidores típicos     |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `notification.sent`   | `{ notificationId, channel, to }`    | Motor cuando **el riel acepta** el mensaje (`markSent`). Honesto: NO hay delivery-receipt real de FCM/APNs/SMS → `deliveredAt` queda NULL hasta un receipt real. NO es "entregado al device", es "el riel lo aceptó". | audit-service, analytics |
| `notification.failed` | `{ notificationId, channel, error }` | Motor al agotar `maxAttempts`                                                                                                                            | audit-service, alerting  |

`key` de Kafka = `notificationId` (orden por entidad). El relay (`OutboxRelay`) drena cada 500 ms.

## Consume (groupId `notification-service`)

| Topic / eventType        | Acción                                                                                                                                                                                                                          | Canal(es)       | Reintentos             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------- |
| `panic.triggered`        | **SOLO** la alerta firmada (webhook) a la central de monitoreo (`onPanic`). El fan-out de SMS YA NO vive acá.                                                                                                                  | WEBHOOK         | Backoff exp. del motor |
| `panic.fanout_requested` | BR-S05: fan-out de SMS + link a hasta **4** contactos de confianza (`onPanicFanout`). El evento lleva **SOLO `contactIds`** (cero PII en Kafka, FOUNDATION §0.7b); los teléfonos se resuelven por **gRPC a share-service**.    | SMS             | Backoff exp. del motor |
| `trip.assigned`          | Push al pasajero ("conductor asignado")                                                                                                                                                                                       | PUSH (FCM/APNs) | Backoff exp. del motor |
| `payment.failed`         | BR-P02: alerta al pasajero + alerta a la central                                                                                                                                                                              | PUSH, WEBHOOK   | Backoff exp. del motor |

Idempotencia: cada notificación derivada lleva una `dedupKey` determinista (Kafka es at-least-once),
p. ej. `panic:<panicId>:sms:<contactId>`, `trip:<tripId>:assigned:push`, `payment:<paymentId>:central`.

> **La `dedupKey` NUNCA lleva PII** (FOUNDATION §0.7(b), soberanía del dato): se indexa por `contactId`,
> **jamás** por el teléfono. El teléfono va al riel (`payload.to`), no a la clave de idempotencia.

## Comandos síncronos (gRPC `veo.notification.v1`)

| RPC               | Uso                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enqueue`         | Encolar una notificación. Cubre el **OTP de contactos de confianza (BR-I06)**: el identity-service llama con `channel=SMS`, `template=contact.otp`, `to=<telefono>`, `payload_json={"vars":{"code":"123456"}}`. |
| `GetNotification` | Consultar estado por id.                                                                                                                                                                                        |

## Gaps de contrato (destinatarios)

> **Decisión:** este servicio **no accede a tablas de otros dominios**. Las direcciones de destino
> (teléfonos de contactos de confianza, tokens push del pasajero, URLs de la central) deben llegar
> en el **payload del evento** (campos opcionales "enriquecidos" que añade el productor) o resolverse
> por **gRPC** al servicio dueño (share-service / identity-service).

Campos enriquecidos esperados por evento (opcionales; si faltan se registra el gap y se omite ese
destinatario sin romper el resto):

- `panic.triggered`: `centralWebhookUrl` (la única pieza que necesita enriquecer; el fan-out NO vive acá).
- `panic.fanout_requested`: `contactIds: [...]` (≤4, **sin PII**: §0.7b), `shareLink`. Los teléfonos los resuelve el consumidor por gRPC a share-service, no viajan en Kafka.
- `trip.assigned`: `passengerId`, `passengerPushToken`, `platform`, `driverName`, `vehiclePlate`, `etaSeconds`.
- `payment.failed`: `passengerId`, `passengerPushToken`, `platform`, `centralWebhookUrl`.

**Pendiente de contrato compartido:** los schemas base en `@veo/events` (`panic.triggered`,
`trip.assigned`, `payment.failed`) no incluyen estos campos. Cuando se quiera garantizar la entrega en
producción, hay dos caminos: (a) ampliar los schemas en `@veo/events` para incluir los destinatarios, o
(b) añadir RPCs de lectura en share-service/identity-service y llamarlos desde los consumidores. Por las
reglas (paquetes `@veo/*` son dist, no editar) no se modificó `@veo/events` desde este servicio.
