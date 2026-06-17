# @veo/notification-service

Motor **propio** de notificaciones de VEO (movilidad segura, Lima). El motor (cola, deduplicación,
reintentos con backoff exponencial y plantillas i18n es-PE) es 100 % self-hosted; los canales son
rieles externos inevitables detrás de **puertos propios** con adapter **live + sandbox** (default
sandbox, determinista en consola).

- HTTP: **3008** · Swagger: `http://localhost:3008/docs` (prefijo global `api/v1`)
- Health: `GET /api/v1/health` (liveness) · `GET /api/v1/health/ready` (readiness: postgres + redis) · `GET /api/v1/metrics`

## Arquitectura

```
REST / Kafka-consumers
        │  encolar(EnqueueInput)
        ▼
 NotificationEngine ──> dedup (dedupKey único) ──> persistir PENDING (cola)
        ▲                                                   │
        │  NotificationWorker (ScheduleModule, intervalo)   │ drena vencidos
        └───────────────── process() ──────────────────────┘
                 │ render (TemplateService i18n)
                 │ route  (ChannelDispatcher)
                 ▼
   ┌─────────────┬───────────────┬───────────────┬──────────────────┐
   │ PushSender  │  SmsSender    │  EmailSender  │  WebhookSender    │
   │ FCM v1+APNs │  SMPP 3.4     │  SMTP propio  │  HTTP firmado     │
   │ (live/sbx)  │  (live/sbx)   │  (live/sbx)   │  (live/sbx)       │
   └─────────────┴───────────────┴───────────────┴──────────────────┘
                 │ éxito → markDelivered + outbox notification.delivered
                 │ fallo recuperable → scheduleRetry (backoff exp.)
                 │ agotado → markFailed + outbox notification.failed
                 ▼
            OutboxRelay → Kafka
```

Capas (Clean Architecture / SOLID): `engine/` (dominio puro y testeable, sin Prisma/Nest en los
contratos), `ports/` (canales tras interfaces — DIP), `infra/` (Prisma, Redis, outbox), `notifications/`
(REST), `consumers/` (Kafka), `grpc/` (comandos síncronos).

## Canales (puertos · live + sandbox)

Selección por entorno (default `sandbox`):

| Canal   | Env                | Live                                                                                           | Sandbox                 |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------- |
| PUSH    | `VEO_PUSH_MODE`    | FCM HTTP v1 (`google-auth-library`) + APNs HTTP/2 (`node:http2` + JWT ES256 con `node:crypto`) | log `[SANDBOX PUSH]`    |
| SMS     | `VEO_SMS_MODE`     | **SMPP 3.4 directo al operador** (cliente propio sobre `node:net`, NO Twilio)                  | log `[SANDBOX SMS]`     |
| EMAIL   | `VEO_EMAIL_MODE`   | SMTP propio (`nodemailer`); dev → Mailpit `localhost:1025`                                     | log `[SANDBOX EMAIL]`   |
| WEBHOOK | `VEO_WEBHOOK_MODE` | HTTP `POST` firmado HMAC-SHA256 (`X-VEO-Signature`, `X-VEO-Timestamp`)                         | log `[SANDBOX WEBHOOK]` |

## Modelo de datos (schema `notification`)

- `notifications`: cola + estado de cada notificación (dedupKey único, attempts, maxAttempts,
  nextAttemptAt, sentAt, deliveredAt, failedReason). La **dirección de destino** viaja en `payload.to`.
- `templates`: plantillas i18n (default `es-PE`), body con placeholders `{{var}}`.
- `outbox_events`: outbox transaccional (FOUNDATION §6).

## Endpoints REST (`/api/v1`, `InternalIdentityGuard`)

- `POST /notifications` — encolar (202). Body: `recipientId, channel, template, to, payload?, dedupKey?, maxAttempts?`.
- `GET /notifications/:id` — estado de una notificación.
- `GET /notifications?recipientId=&limit=` — listar por destinatario.

## Eventos

Ver [`docs/events.md`](docs/events.md). Publica `notification.delivered` / `notification.failed` por
outbox; consume `panic.triggered`, `trip.assigned`, `payment.failed`.

## Desarrollo

```bash
# Infra: postgres :5433, redis :6379, kafka :9094, (mailpit :1025 para email live)
pnpm --filter @veo/notification-service codegen      # prisma generate
pnpm --filter @veo/notification-service db:migrate    # prisma migrate deploy
pnpm --filter @veo/notification-service db:seed        # plantillas es-PE por defecto
pnpm --filter @veo/notification-service dev            # nest start --watch

pnpm --filter @veo/notification-service typecheck
pnpm --filter @veo/notification-service test           # vitest (dedup, retry/backoff, routing)
```

Variables relevantes: `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `INTERNAL_IDENTITY_SECRET`,
`NOTIFICATION_*` (backoff/worker), `VEO_*_MODE`, credenciales `FCM_*` / `APNS_*` / `SMPP_*` / `SMTP_*`,
`WEBHOOK_SIGNING_SECRET`, `CENTRAL_ALERT_WEBHOOK_URL`. Ver `src/config/env.schema.ts`.
