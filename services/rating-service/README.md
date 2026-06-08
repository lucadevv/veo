# @veo/rating-service

Calificaciones post-viaje (1–5), **promedio rolling de 30 días** por sujeto y **flags** de revisión /
suspensión / re-verificación (BR-D01 conductor, BR-I05 pasajero). VEO · movilidad segura, Lima.

- HTTP: **3010** · prefijo global `/api/v1` · Swagger: `http://localhost:3010/docs`
- gRPC: **0.0.0.0:50060** · paquete `veo.rating.v1` (lo usa dispatch para el scoring)
- Health: `GET /api/v1/health` (liveness) · `GET /api/v1/health/ready` (readiness: Postgres + Redis)
- Métricas Prometheus: `GET /api/v1/metrics` · OTel auto-instrumentado (http/express/kafkajs/pg)

## Arquitectura

Clean Architecture / feature-first. Mismo molde que `identity-service`:

```
src/
  config/env.schema.ts        Validación de entorno (zod)
  infra/                      Singletons: Prisma (read/write), Redis, OutboxRelay, CoreModule
  ratings/
    domain/                   Lógica PURA y testeada (sin I/O):
      rolling-average.ts        promedio rolling + filtro de ventana
      flags.ts                  umbrales BR-D01 / BR-I05
    dto/rating.dto.ts         DTOs + Swagger + class-validator
    ratings.service.ts        Casos de uso (crea rating, recalcula agregado, emite eventos)
    ratings.controller.ts     REST (InternalIdentityGuard)
    rating-recompute.cron.ts  Cron diario (ventana deslizante) con lock en Redis
    trip-completed.consumer.ts Consumidor Kafka de trip.completed (arranque resiliente)
  grpc/rating.grpc.controller.ts  veo.rating.v1.RatingService/GetAggregate
```

## Modelo de datos (schema `rating`)

- `ratings` (`id` UUIDv7, `trip_id` **UNIQUE**, `rater_id`, `rated_id`, `stars` int **CHECK 1..5**, `comment?`, `created_at`)
- `rating_aggregates` (`subject_id` PK, `role` `DRIVER|PASSENGER`, `rolling_avg_30d` numeric(3,2), `count_30d`, `flagged`, `flag_reason?`, `last_computed_at`)
- `outbox_events` (patrón outbox)

## Reglas de negocio

- **Un rating por viaje**: `UNIQUE(trip_id)` + chequeo previo → `409 CONFLICT` (`ConflictError`).
- **Promedio rolling 30 días**: solo cuentan calificaciones con `created_at >= now - ROLLING_WINDOW_DAYS`.
- **BR-D01 (conductor)**: `rollingAvg < 4.3` → flag `review`; `< 4.0` → flag `suspension` → emite `driver.flagged`.
- **BR-I05 (pasajero)**: `rollingAvg < 4.0` → flag `reverification` → emite `passenger.flagged`.
  - Fronteras: `4.3` exacto **no** marca; `4.0` exacto entra en `review` (conductor) / **no** marca (pasajero).
  - Los flags solo se evalúan con `count > 0`. El evento se emite solo en la **transición** a un nuevo flag.
- **Cron diario** (`RECOMPUTE_CRON`, default `03:10`): recalcula todos los agregados (ventana deslizante)
  y re-evalúa flags; lock distribuido en Redis para multi-réplica.

## API REST

| Método | Ruta | Guard | Descripción |
|---|---|---|---|
| `POST` | `/api/v1/ratings` | `InternalIdentityGuard` | Crear calificación. Body: `{ tripId, ratedId, ratedRole, stars, comment? }`. `raterId` = usuario autenticado. |
| `GET`  | `/api/v1/ratings?tripId=` | `InternalIdentityGuard` | Calificación de un viaje. |
| `GET`  | `/api/v1/ratings/aggregate/:subjectId` | `InternalIdentityGuard` | Agregado (promedio rolling + flags). |

gRPC: `RatingService/GetAggregate({ subjectId })` → `{ subjectId, role, rollingAvg30d, count30d, flagged, flagReason, lastComputedAt, found }`.

## Eventos

Ver [`docs/events.md`](docs/events.md). Publica `rating.created`, `driver.flagged`, `passenger.flagged`
(todos vía outbox). Consume `trip.completed`.

## Desarrollo

```bash
# Migración (DB en localhost:5433, schema rating)
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo?schema=rating" pnpm --filter @veo/rating-service exec prisma generate
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo?schema=rating" pnpm --filter @veo/rating-service db:migrate

# Calidad
pnpm --filter @veo/rating-service typecheck
pnpm --filter @veo/rating-service test

# Arranque
pnpm --filter @veo/rating-service dev      # nest start --watch (emite decorator metadata)
```

> Nota de empaquetado: el cliente Prisma se genera en `src/generated/prisma`. `nest build` (tsc) no
> copia ese JS a `dist`, por lo que el `Dockerfile` ejecuta `prisma generate` y copia
> `src/generated → dist/generated`. La ejecución vía `tsx`/esbuild **no** sirve para DI porque no emite
> `emitDecoratorMetadata`; usar `nest start` (dev) o `node dist/main.js` (prod).

## Necesidades de contrato compartido no cubiertas

Estos puntos requieren cambios en paquetes `@veo/*` (que no debo editar) y quedan reportados:

1. **`passenger.flagged` no existe en `@veo/events` (`EVENT_SCHEMAS`).** BR-I05 exige un evento de
   re-verificación del pasajero; hoy se publica sin validación de payload. Propuesta de contrato:
   `passenger.flagged = { passengerId: string, rollingAvg: number, reason: string }` (topic `passenger`).
2. **`rating.created` es específico de conductor** (`{ ratingId, tripId, driverId, stars }`). Para
   calificaciones de pasajero se reutiliza `driverId` como id del sujeto calificado. Sería más limpio un
   contrato con `subjectId` + `role` (p. ej. `{ ratingId, tripId, subjectId, role, stars }`).
3. **`trip.completed` no incluye participantes** (`driverId`/`passengerId`), por lo que no se puede
   derivar automáticamente quién califica a quién; el `POST /ratings` recibe `ratedId`/`ratedRole`.
