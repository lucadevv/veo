# Eventos de `notification-service`

El motor publica resultados de entrega vía **OUTBOX → Kafka** y consume eventos de dominio para
disparar notificaciones reales. Todos los payloads usan el envelope de `@veo/events`.

## Publica (vía outbox)

| Topic / eventType        | Schema (`EVENT_SCHEMAS`)                              | Disparado por                | Consumidores típicos          |
|--------------------------|------------------------------------------------------|------------------------------|-------------------------------|
| `notification.delivered` | `{ notificationId, channel, to }`                    | Motor al entregar con éxito  | audit-service, analytics      |
| `notification.failed`    | `{ notificationId, channel, error }`                 | Motor al agotar `maxAttempts`| audit-service, alerting       |

`key` de Kafka = `notificationId` (orden por entidad). El relay (`OutboxRelay`) drena cada 500 ms.

## Consume (groupId `notification-service`)

| Topic / eventType   | Acción                                                                                              | Canal(es)        | Reintentos |
|---------------------|----------------------------------------------------------------------------------------------------|------------------|------------|
| `panic.triggered`   | BR-S05: SMS + link a hasta **4** contactos de confianza + alerta firmada a la central de monitoreo | SMS, WEBHOOK     | Backoff exp. del motor |
| `trip.assigned`     | Push al pasajero ("conductor asignado")                                                             | PUSH (FCM/APNs)  | Backoff exp. del motor |
| `payment.failed`    | BR-P02: alerta al pasajero + alerta a la central                                                    | PUSH, WEBHOOK    | Backoff exp. del motor |

Idempotencia: cada notificación derivada lleva una `dedupKey` determinista (Kafka es at-least-once),
p. ej. `panic:<panicId>:sms:<phone>`, `trip:<tripId>:assigned:push`, `payment:<paymentId>:central`.

## Comandos síncronos (gRPC `veo.notification.v1`)

| RPC                | Uso                                                                                  |
|--------------------|--------------------------------------------------------------------------------------|
| `Enqueue`          | Encolar una notificación. Cubre el **OTP de contactos de confianza (BR-I06)**: el identity-service llama con `channel=SMS`, `template=contact.otp`, `to=<telefono>`, `payload_json={"vars":{"code":"123456"}}`. |
| `GetNotification`  | Consultar estado por id.                                                              |

## Gaps de contrato (destinatarios)

> **Decisión:** este servicio **no accede a tablas de otros dominios**. Las direcciones de destino
> (teléfonos de contactos de confianza, tokens push del pasajero, URLs de la central) deben llegar
> en el **payload del evento** (campos opcionales "enriquecidos" que añade el productor) o resolverse
> por **gRPC** al servicio dueño (share-service / identity-service).

Campos enriquecidos esperados por evento (opcionales; si faltan se registra el gap y se omite ese
destinatario sin romper el resto):

- `panic.triggered`: `contacts: [{ name?, phone }]` (≤4), `shareLink`, `centralWebhookUrl`.
- `trip.assigned`: `passengerId`, `passengerPushToken`, `platform`, `driverName`, `vehiclePlate`, `etaSeconds`.
- `payment.failed`: `passengerId`, `passengerPushToken`, `platform`, `centralWebhookUrl`.

**Pendiente de contrato compartido:** los schemas base en `@veo/events` (`panic.triggered`,
`trip.assigned`, `payment.failed`) no incluyen estos campos. Cuando se quiera garantizar la entrega en
producción, hay dos caminos: (a) ampliar los schemas en `@veo/events` para incluir los destinatarios, o
(b) añadir RPCs de lectura en share-service/identity-service y llamarlos desde los consumidores. Por las
reglas (paquetes `@veo/*` son dist, no editar) no se modificó `@veo/events` desde este servicio.
