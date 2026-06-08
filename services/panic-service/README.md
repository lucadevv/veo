# @veo/panic-service

Botón de pánico de VEO (movilidad segura, Lima). Sistema **crítico de seguridad**: idempotencia real
(BR-S04), publicación confiable de eventos vía outbox (BR-S05) y registro de evidencia con
**S3 Object Lock (WORM)**. Latencia del ack al cliente: **<800ms p99**.

- HTTP: **3006** · gRPC: **0.0.0.0:50056** (`veo.panic.v1`)
- Swagger: `http://localhost:3006/docs`
- Prefijo API: `/api/v1` · Health: `/health`, `/health/ready` · Métricas: `/metrics`

## Arquitectura

```
Cliente ──(POST /panic, firma HMAC + identidad interna BFF)──▶ panic-service
                                                                  │ (1 tx)
                                                       INSERT panic_events (dedupKey UNIQUE)
                                                       INSERT outbox (panic.triggered)
                                                                  │
                                                       202 Accepted  ◀── ack <800ms p99
                                                                  │
                                            OutboxRelay (500ms) ──▶ Kafka topic `panic`
                                                                  │
                          notification-service (SMS+link 4 contactos, push central)
                          media-service (force-start grabación → evidencia S3 Object Lock)
```

El servicio **persiste + encola y responde 202 de inmediato**. NO hace fan-out síncrono: el fan-out
real lo ejecutan los consumidores de `panic.triggered` (ver `docs/events.md`).

## Reglas de negocio

### BR-S04 · Idempotencia
`POST /panic` recibe `{ tripId, dedupKey (UUIDv7), geo:{lat,lon}, signature }`.

1. Se valida que `dedupKey` sea **UUIDv7** y se verifica la **firma HMAC** (rechazo si inválida).
2. `INSERT ... ` con `dedup_key UNIQUE`. La primera vez crea la fila y encola `panic.triggered`.
   Las siguientes con la misma `dedupKey` son **no-op idempotente** (unique + catch `P2002`) y
   devuelven el **mismo `panicId`** con `deduplicated: true`. Ni fila nueva ni evento nuevo.
3. Responde **202** en <800ms (medido con métrica). Latencia expuesta en header `x-veo-panic-ack-ms`.

> ⚠️ **Este endpoint NUNCA se throttlea.** El rate-limit del BFF **debe excluir** `POST /panic`:
> bajo coacción el usuario puede pulsar el botón muchas veces; el throttle pondría en riesgo vidas.
> La idempotencia (no la limitación de tasa) es la que protege la base de datos del doble submit.

### Firma HMAC (contrato cliente)
Mensaje canónico (`panic.trigger:v1`), campos separados por `\n`:

```
panic.trigger:v1
<tripId>
<dedupKey>
<lat con 6 decimales fijos>     # ej. -12.046400
<lon con 6 decimales fijos>     # ej. -77.042800
```

`signature = HMAC_SHA256(mensaje, PANIC_HMAC_SECRET)` en hex. Se fijan 6 decimales (~0.11 m) para
evitar divergencias por formato de coma flotante entre cliente (Flutter/JS) y servidor.

### BR-S05 · Fan-out
El fan-out (SMS+link a 4 contactos, push a central) lo hace **notification-service** consumiendo
`panic.triggered`. Aquí solo se garantiza la publicación inmediata y confiable vía outbox.

### Evidencia (S3 Object Lock / WORM)
- En el trigger se **reservan** keys S3 (función pura, sin I/O → no penaliza el SLO). `media-service`
  sube los objetos a esas rutas tras el force-start.
- `POST /panic/:id/evidence` anexa keys y (si `finalize`) aplica **retención WORM** (Object Lock,
  modo COMPLIANCE) sobre los objetos ya subidos. Inmutable y no borrable durante la retención.
- Self-hosted: en dev el riel es **MinIO** (`http://localhost:9002`, `forcePathStyle`). En prod,
  almacén compatible S3 con Object Lock. Modo configurable con `VEO_EVIDENCE_MODE` (`live`|`sandbox`).

## Endpoints REST

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/v1/panic` | InternalIdentity + HMAC | Disparar pánico (202, idempotente). **Sin throttle.** |
| GET | `/api/v1/panic/:id` | InternalIdentity | Obtener un evento de pánico |
| GET | `/api/v1/panic?status=` | RBAC operadores | Listar eventos (filtrable por estado) |
| POST | `/api/v1/panic/:id/ack` | RBAC `COMPLIANCE_SUPERVISOR`/`SUPPORT_*`/`ADMIN`/`SUPERADMIN` | Reconocer (ACKNOWLEDGED) |
| POST | `/api/v1/panic/:id/resolve` | RBAC operadores | Cerrar (`RESOLVED`\|`FALSE_ALARM`) |
| POST | `/api/v1/panic/:id/evidence` | RBAC operadores | Anexar keys S3 (Object Lock si `finalize`) |

gRPC `veo.panic.v1.PanicService/GetPanic` para lectura síncrona desde otros servicios.

## Modelo de datos (schema `panic`)
- `panic_events`: `id` (UUIDv7), `tripId`, `passengerId`, `triggeredAt`, `geoLat`, `geoLon`,
  `dedupKey` (**UNIQUE NOT NULL**), `status` (`PanicStatus`), `evidenceS3Keys text[]`,
  `acknowledgedAt?`, `ackBy?`, `resolvedAt?`, `createdAt`.
- `outbox_events`: outbox transaccional (FOUNDATION §6).

## Observabilidad
- OTel (`bootstrapOtel`), logs pino con redacción PII, `AllExceptionsFilter`, `LoggingInterceptor`.
- Métricas propias (Prometheus): `veo_panic_trigger_ack_duration_seconds` (SLO <800ms p99) y
  `veo_panic_operator_ack_duration_seconds`.

## Desarrollo

```bash
# Cliente Prisma
pnpm --filter @veo/panic-service exec prisma generate

# Migración (dev)
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo" \
  pnpm --filter @veo/panic-service exec prisma migrate deploy

# Arrancar
pnpm --filter @veo/panic-service dev

# Calidad
pnpm --filter @veo/panic-service typecheck
pnpm --filter @veo/panic-service test     # unit (vitest) + e2e (testcontainers, Postgres real)
```

> Los tests e2e requieren Docker (testcontainers levanta un Postgres efímero; la DB **no** se mockea).
