# Eventos de `panic-service`

Todos los eventos se publican vía **OUTBOX** (misma transacción que la mutación de dominio) y los
drena el `OutboxRelay` a Kafka. Esto garantiza la publicación confiable sin acoplar el ack al cliente
(SLO <800ms p99) a la latencia de Kafka (BR-S05).

## Publica

| Topic | eventType | Schema (`@veo/events`) | Disparado por | Consumidores | Key |
|---|---|---|---|---|---|
| `panic` | `panic.triggered` | `{ panicId, tripId, passengerId, geo:{lat,lon}, dedupKey, triggeredAt }` | `POST /panic` (primer submit de una dedupKey) | **notification-service** (fan-out SMS+link a 4 contactos, push a central), **media-service** (force-start de grabación), **dispatch/audit** | `panicId` |
| `panic` | `panic.acknowledged` | `{ panicId, operatorId, ackAt }` | `POST /panic/:id/ack` | audit-service, notification-service (cierre de aviso a contactos) | `panicId` |

> El `envelope` lleva `dedupKey` (= dedupKey del pánico) para que los consumidores puedan deduplicar
> ante una republicación del relay (idempotencia extremo a extremo).

### Contrato de fan-out (BR-S05)

`panic-service` **NO** ejecuta el fan-out de forma síncrona. Solo garantiza la **publicación inmediata
y confiable** de `panic.triggered`. El fan-out real es responsabilidad de los consumidores:

- **notification-service**: al consumir `panic.triggered`, envía SMS con link de seguimiento a los
  4 contactos de confianza del pasajero y push a la central de monitoreo.
- **media-service**: al consumir `panic.triggered`, hace el *force-start* de la grabación del viaje y
  sube los objetos a las keys S3 (Object Lock) reservadas para la evidencia.

## Consume

`panic-service` actualmente **no consume** eventos de Kafka. La entrada es:
- HTTP `POST /panic` (cliente, firmado HMAC + identidad interna del BFF).
- Endpoints de operador (ack/resolve/evidence) bajo RBAC.

| Topic | Schema | Acción | Reintentos |
|---|---|---|---|
| — | — | — | — |
