# media-service

Servicio de **video seguro** de VEO (movilidad segura, Lima). Orquesta grabación de viajes con
**LiveKit self-hosted**, archiva a **S3/MinIO** (self-hosted, `forcePathStyle`) y gobierna el
**acceso auditado** a esos videos con doble autorización, watermark dinámico y retención legal.

- HTTP: `:3007` · prefijo `/api/v1` · Swagger en `/docs`
- gRPC: `0.0.0.0:50057` · paquete `veo.media.v1`
- Health: `/health`, `/health/ready` · Métricas Prometheus: `/metrics` · OTel activado en `main.ts`

Arquitectura: NestJS + Clean Architecture. LiveKit y S3 viven **detrás de puertos** (`LiveKitPort`,
`StoragePort`) con adapters `live` (producción real) y `sandbox` (tests/dev deterministas). El
dominio no depende de `livekit-server-sdk` ni de `@aws-sdk` (regla D de SOLID).

## Reglas de negocio

### BR-S01 · Cámara y grabación
- `POST /media/rooms/:tripId/token` emite un token LiveKit (room `trip-<tripId>`) al passenger/driver.
- Al consumir `trip.started` se inicia la grabación (egress LiveKit → S3) y se publica
  `media.recording_started`. Al `trip.completed` se detiene y se publica `media.archived`.
- **Excepción de pánico:** al consumir `panic.triggered` se **fuerza** el inicio de grabación aunque
  el viaje no esté `IN_PROGRESS` (force-start) y la retención del segmento pasa a **indefinida**.

### BR-S02 · Acceso a video (doble autorización + watermark)
1. `POST /media/access` — un operador crea una solicitud con `reason` (> 20 chars; CHECK en DB).
2. `POST /media/access/:id/approve` — exige rol **`COMPLIANCE_SUPERVISOR`** (RBAC) **y MFA fresca**
   (`StepUpMfaGuard`). Genera una **URL prefirmada de S3 válida 5 minutos** + un **watermark
   dinámico con el email del operador**, incrementa `accessedCount` y publica `media.access_granted`
   para `audit-service`.
3. `GET /media/segments?tripId=…` — metadatos de segmentos (solo cumplimiento; **nunca** URLs).

### BR-S03 · Retención
- Por defecto **30 días**; viajes con **incidente 180 días**; viajes con **pánico → indefinido**
  (`retention_until = NULL`) hasta su resolución.
- El `RetentionSweeper` (cron diario) borra de S3 y de la base los segmentos vencidos; nunca toca los
  indefinidos.

## Modelo de datos (schema `media`)
- `media_segments` — un segmento de grabación por viaje (room LiveKit → objeto S3). `retention_until`
  NULL = indefinido. Banderas `has_incident` / `has_panic` para el cálculo de retención.
- `video_access_requests` — ciclo de solicitud/aprobación de acceso (`reason` con CHECK > 20,
  `watermark`, `signed_url_expires_at`).
- `outbox_events` — outbox transaccional.

## Eventos
Ver [`docs/events.md`](./docs/events.md). Publica `media.recording_started`, `media.archived` y
(propuesto) `media.access_granted`. Consume `trip.started`, `trip.completed`, `panic.triggered`.

## Variables de entorno
Ver `src/config/env.schema.ts`. Claves principales (defaults de dev):

```
PORT=3007
GRPC_URL=0.0.0.0:50057
DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo   # schema "media"
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9094
VEO_LIVEKIT_MODE=sandbox|live      LIVEKIT_URL=ws://localhost:7880   LIVEKIT_API_KEY=devkey   LIVEKIT_API_SECRET=devsecret_change_in_production
VEO_STORAGE_MODE=sandbox|live      S3_ENDPOINT=http://localhost:9002  S3_ACCESS_KEY=veo_dev    S3_SECRET_KEY=veo_dev_secret   S3_BUCKET_VIDEO=veo-video-dev   S3_FORCE_PATH_STYLE=true
RETENTION_DEFAULT_DAYS=30   RETENTION_INCIDENT_DAYS=180   SIGNED_URL_TTL_SECONDS=300
```

> En `production`, `VEO_LIVEKIT_MODE=live` y `VEO_STORAGE_MODE=live` orquestan los servidores propios
> reales. Los modos `sandbox` son deterministas para tests y dev sin LiveKit levantado.

## Comandos
```bash
pnpm --filter @veo/media-service codegen        # prisma generate
pnpm --filter @veo/media-service db:migrate     # prisma migrate deploy (schema media)
pnpm --filter @veo/media-service typecheck
pnpm --filter @veo/media-service test           # vitest (retención, doble-auth, watermark, BR-S01)
pnpm --filter @veo/media-service dev
```
