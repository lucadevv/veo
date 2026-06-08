# @veo/driver-bff

Backend for Frontend de la **app del conductor** (VEO). Valida el JWT en el gateway y propaga la
identidad firmada (HMAC) aguas abajo. Arquitectura **híbrida**:

- **Lecturas** → gRPC (`@veo/rpc` `createGrpcClient`) contra los microservicios.
- **Comandos** → REST interno firmado (`@veo/rpc` `InternalRestClient`) con la identidad del conductor.
- **Tiempo real** → Socket.IO namespace `/driver` alimentado por un consumidor Kafka.

> El GPS del conductor **no** pasa por aquí: la app lo envía por MQTT al `tracking-service` (Go).

Puerto: **4002**. Prefijo HTTP: **`/api/v1`** (excepto `health`, `health/ready`, `metrics`).
Swagger: **`/docs`**.

## Endpoints (REST/JSON, bajo `/api/v1`)

### Auth (passthrough a identity, PÚBLICO, solo rate-limit)
- `POST /auth/otp/request` · `POST /auth/otp/verify` (fuerza `type=driver`) · `POST /auth/refresh` · `POST /auth/logout`

### Sesión / onboarding del conductor (JWT driver)
- `POST /drivers/onboard`
- `POST /drivers/shift/start` · `POST /drivers/shift/end` · `POST /drivers/shift/pause`
- `GET  /drivers/me` → agrega gRPC `identity.GetDriverByUser` + `identity.GetUser` + `rating.GetAggregate`
  + `fleet.GetDriverDocuments` (estado de cumplimiento de documentos).

### Ofertas de dispatch (JWT driver)
- `GET  /dispatch/surge?lat&lon` (gRPC `GetSurge`)
- `GET  /dispatch/offers/:matchId` (gRPC `GetMatch`)
- `POST /dispatch/offers/:matchId/accept` · `POST /dispatch/offers/:matchId/reject` (REST)

### Viajes — lado conductor (JWT driver)
- `GET  /trips/:id` (gRPC `GetTrip`) · `GET /trips/:id/state` (gRPC `GetTripState`)
- `POST /trips/:id/accept` · `/arriving` · `/arrived` · `/start` · `/complete` · `/cancel` (REST; `cancel` fija `by=DRIVER`)

### Pagos / payouts (JWT driver)
- `GET /payouts` (filtrado al `driverId` del conductor autenticado; REST a payouts)
- `GET /payments/:id` (gRPC `GetPayment`)

### Notificaciones (JWT driver)
- `GET /notifications?limit` (filtradas a `recipientId = userId`; REST a notification)

### Operación
- `GET /health` (liveness) · `GET /health/ready` (Redis + identity) · `GET /metrics` (Prometheus)

## Socket.IO

- Namespace **`/driver`**. Handshake con JWT Bearer (`auth.token` o header `Authorization`); se verifica
  (ES256), se exige `type=driver`, se resuelve el `driverId` (gRPC `identity.GetDriverByUser`) y se une
  el socket a la sala **`driver:{driverId}`**.
- Eventos emitidos: `dispatch:offer`, `dispatch:match`, `trip:update`.

## Eventos Kafka consumidos

Consumidor (`groupId=driver-bff`) sobre los topics **`dispatch`** y **`trip`**; valida el payload con
`EVENT_SCHEMAS` de `@veo/events` y enruta al conductor:

| eventType | topic | Socket.IO |
|---|---|---|
| `dispatch.offered` | dispatch | `dispatch:offer` |
| `dispatch.match_found` | dispatch | `dispatch:match` |
| `trip.assigned/accepted/arriving/arrived/started/completed/cancelled` | trip | `trip:update` |

El `driverId` se toma del payload; si falta (p.ej. `trip.cancelled`) se resuelve por gRPC `trip.GetTrip`.

## Variables de entorno

Validadas con Zod al arranque (`src/config/env.schema.ts`). Defaults solo para desarrollo:

`NODE_ENV`, `PORT=4002`, `LOG_LEVEL`, `CORS_ORIGINS`,
`VEO_JWT_PUBLIC_PEM` (obligatoria en prod), `VEO_JWT_ISSUER`, `VEO_JWT_AUDIENCE`,
`VEO_INTERNAL_IDENTITY_SECRET`, `REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_GROUP_ID`,
`IDENTITY_GRPC_URL`, `TRIP_GRPC_URL`, `DISPATCH_GRPC_URL`, `PAYMENT_GRPC_URL`,
`NOTIFICATION_GRPC_URL`, `RATING_GRPC_URL`, `FLEET_GRPC_URL`,
`IDENTITY_URL`, `TRIP_URL`, `DISPATCH_URL`, `PAYMENT_URL`, `PAYOUTS_URL`, `NOTIFICATION_URL`, `FLEET_URL`,
`RATE_LIMIT_WINDOW_SECONDS=60`, `RATE_LIMIT_MAX=120`, `DOWNSTREAM_TIMEOUT_MS=8000`,
`OTEL_EXPORTER_OTLP_ENDPOINT`.

## Calidad

```bash
pnpm --filter @veo/driver-bff typecheck
pnpm --filter @veo/driver-bff lint
pnpm --filter @veo/driver-bff test
```

Rate limiting propio sobre Redis (IP + usuario + ruta). Errores mapeados al modelo público
`{ error: { code, message, details?, traceId } }` (incluye `DownstreamError`).
