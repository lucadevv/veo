# chat-service (Ola 2A)

Mensajería in-app **conductor↔pasajero** durante un viaje activo. Puerto **3014**, schema Postgres `chat`.

Pragmático y soberano: este servicio SOLO **persiste y lee** mensajes. La **autorización** (el usuario
pertenece al viaje + el viaje está activo) y la **entrega en tiempo real** las hacen los **BFFs**,
reutilizando su infraestructura Socket.IO existente (`/passenger` en public-bff, `/driver` en driver-bff)
con el evento `chat:message` y una sala por `tripId`. No se crea una capa WS nueva aquí.

## Endpoints (internos, REST firmado HMAC — `InternalIdentityGuard`)

| Método | Ruta                                         | Descripción                                                      |
| ------ | -------------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/v1/chat/trips/:tripId/messages?limit=` | Historial (orden cronológico asc, máx 100).                      |
| POST   | `/api/v1/chat/trips/:tripId/messages`        | Persiste `{ senderId, senderRole, body }` → devuelve el mensaje. |

Los BFFs validan membresía/estado del viaje (gRPC GetTrip) antes de llamar, fijan `senderId`/`senderRole`
desde la identidad autenticada y, tras persistir, emiten `chat:message` por socket a la otra parte.

## Modelo

`Message { id, tripId, senderId, senderRole(PASSENGER|DRIVER), body, createdAt }`.

## Operación

Health (`/health`, `/health/ready` con DB+Redis), métricas (`/metrics`), OTel, `/api/v1`, Swagger en `/docs`.
