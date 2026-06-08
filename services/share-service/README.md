# share-service · VEO

Servicio de **movilidad segura**: contactos de confianza (BR-I06), **enlaces de seguimiento firmados**
(BR-S05) y la **página pública "familia"** para seguir un viaje en tiempo (casi) real.

- HTTP: `:3011` · prefijo global `/api/v1` · Swagger en `/docs`
- gRPC: `0.0.0.0:50061` · paquete `veo.share.v1`
- Schema Postgres: `share`

## Responsabilidades

1. **Contactos de confianza (BR-I06)**
   - Máximo **3** por usuario.
   - Cada contacto requiere **OTP por SMS** (puerto SMS; en sandbox imprime el código) y verificación
     (`otpVerifiedAt`).
   - Modificar la lista (alta/baja) tiene **cool-down de 24h**.
2. **Enlaces de seguimiento firmados (BR-S05)**
   - Token aleatorio firmado con HMAC; en BD solo se guarda el **`sha256` del token**.
   - Expiración configurable (def. 2h) y `maxUses`.
   - Endpoint **público** que valida el token (firma + expiración + estado), incrementa `usedCount`,
     registra `share_view` y publica `share.viewed`.
3. **Pánico (BR-S05)**: al consumir `panic.triggered` genera/activa enlaces para los contactos de
   confianza y publica `share.link_generated` (+ envía el SMS con el enlace).

> La información del viaje (estado y ubicación aproximada) proviene del **read-model `trip_snapshots`**
> alimentado por eventos (`trip.started`, `panic.triggered`). **No** se consultan tablas de otros
> servicios. (Si en el futuro existe gRPC de trip/tracking, se puede enriquecer la ubicación en vivo.)

## Arquitectura

Clean Architecture / feature-first, mismo patrón que `identity-service`:

```
src/
  config/env.schema.ts        Validación de entorno (zod)
  infra/                      Prisma (read/write split), Redis, OutboxRelay, CoreModule (global)
  ports/sms/                  Puerto SMS (sandbox imprime; live = gateway operador)
  contacts/                   BR-I06: service, OTP, reglas puras, controller, DTOs
  share/                      BR-S05: firma/verificación (puro), service, controllers (privado + público)
  read-model/                 TripSnapshot (CQRS read-model desde eventos)
  consumers/                  KafkaEventConsumer (trip.started, panic.triggered)
  grpc/                       veo.share.v1 (GetTrustedContacts)
  generated/prisma/           Cliente Prisma generado
```

## Endpoints REST (`/api/v1`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/contacts` | InternalIdentityGuard | Lista contactos de confianza |
| `POST` | `/contacts` | InternalIdentityGuard | Alta de contacto (máx 3, envía OTP) |
| `POST` | `/contacts/:id/verify-otp` | InternalIdentityGuard | Verifica el OTP del contacto |
| `POST` | `/contacts/:id/resend-otp` | InternalIdentityGuard | Reenvía el OTP |
| `DELETE` | `/contacts/:id` | InternalIdentityGuard | Baja de contacto (cool-down 24h) |
| `POST` | `/share/:tripId` | InternalIdentityGuard | Crea enlace de seguimiento firmado |
| `POST` | `/share/:id/revoke` | InternalIdentityGuard | Revoca un enlace |
| `GET` | `/public/share/:token` | **Público** (`@Public`) | Página familia: estado + ubicación aprox. |
| `GET` | `/healthz`, `/readyz` | Público | Liveness / readiness |
| `GET` | `/metrics` | Público | Métricas Prometheus |

## gRPC (`veo.share.v1`)

- `GetTrustedContacts(GetTrustedContactsRequest{ user_id })` → contactos verificados (lo usan
  notification/panic).

## Eventos

Ver [`docs/events.md`](./docs/events.md). Publica `share.link_generated` y `share.viewed` (outbox);
consume `trip.started` y `panic.triggered`.

## Desarrollo

```bash
# Variables (ver .env.example). Servicios locales: Postgres :5433, Redis :6379, Kafka :9094.
export DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo"

pnpm --filter @veo/share-service codegen        # prisma generate
pnpm --filter @veo/share-service db:migrate     # prisma migrate deploy
pnpm --filter @veo/share-service typecheck
pnpm --filter @veo/share-service test           # vitest (unit)
pnpm --filter @veo/share-service dev            # nest start --watch
```

## Seguridad

- El token del enlace **nunca** se persiste ni se difunde en eventos: solo su `sha256`.
- Firma HMAC + expiración verificadas criptográficamente antes de tocar la BD.
- OTP hasheado en Redis con TTL, rate-limit de reenvío y límite de intentos.
- `helmet`, `ValidationPipe` (whitelist), `AllExceptionsFilter` que mapea `DomainError` a HTTP.
