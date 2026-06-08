# @veo/dispatch-service

Matching geoespacial (H3), scoring (BR-T06), surge pricing y prioridad de pánico para VEO
(movilidad segura, Lima). Producción real, sin mocks de dominio.

Puerto local: **3003** · gRPC: **0.0.0.0:50053** · Swagger: `http://localhost:3003/docs`

## Arquitectura

Clean Architecture / feature-first sobre NestJS, clonando la estructura de `identity-service`:

```
src/
  config/env.schema.ts        Validación de entorno (Zod)
  infra/                      Prisma (read/write), Redis, outbox relay, CoreModule (global)
  ports/maps/                 Puerto @veo/maps (ETA self-hosted, NO Google)
  hot-index/                  Hot index Redis (ubicación + disponibilidad) y exclusión por pánico
                              - redis-hot-index.ts     (LUA atómico SREM+SADD para mover de celda)
                              - in-memory-hot-index.ts (doble en memoria, solo tests unit)
  dispatch/                   Dominio: scoring (puro), matching (oferta/timeout/expansión),
                              surge, proyección de stats, accept/reject, controller REST + DTOs
  messaging/                  Consumidores Kafka
  grpc/                       Controlador gRPC veo.dispatch.v1 (GetMatch, GetSurge)
```

### Hot index (Redis, NO Postgres)

- `driver:loc:{id}` → `{lat,lon,h3,updatedAt}` con TTL (`DRIVER_LOC_TTL_SECONDS`, 60s).
- `h3:available:{cell}` → SET de `driverId` disponibles en esa celda H3 (res 9).
- Mover un conductor entre celdas es **atómico** (script LUA: `SREM` celda vieja + `SADD` celda nueva
  + refresh de `loc`).
- `dispatch:excluded:drivers` → SET de exclusión por pánico.

### Algoritmo de matching (BR-T06)

1. `h3(origin)` res 9; candidatos del **k-ring radio 1** (`neighbors(cell,1)`) desde Redis.
2. Excluye conductores en pánico y ya ofertados.
3. Scoring y orden descendente:
   `score = w_dist·(1/distM) + w_rating·avgRating + w_idle·(1/segDesdeUltimoViaje) − w_cancel·cancelRate`
   (pesos configurables por env).
4. Oferta **secuencial** al top-1 con timeout (`DISPATCH_OFFER_TIMEOUT_MS`, 12s). Rechazo/expiración → siguiente.
5. Tras `DISPATCH_REJECTS_BEFORE_EXPAND` (5) rechazos en radio 1 → expande al **k-ring radio 2**.
6. Aceptación → `dispatch.match_found` (outbox, misma tx que `accept`). Agotados → `dispatch.timeout`.

SLO objetivo p99 < 1.5s request→primera oferta: candidatos desde Redis; ETA (`@veo/maps`) por oferta
(no bloquea el ranking).

### Surge

Si el origen cae en una `surge_zone` activa **y** demanda/oferta supera el umbral → `multiplier` (1.2–2.0).
Se expone en `GET /dispatch/surge` y en el match (`surge_multiplier`) para que trip-service lo use en la tarifa.

## Endpoints REST (bajo `/api/v1`, protegidos por `InternalIdentityGuard`)

- `POST /api/v1/dispatch/offers/:matchId/accept` — el conductor acepta (publica `dispatch.match_found`).
- `POST /api/v1/dispatch/offers/:matchId/reject` — el conductor rechaza (se ofrece al siguiente).
- `GET  /api/v1/dispatch/offers/:matchId` — estado del match.
- `GET  /api/v1/dispatch/surge?lat&lon` — cotiza el multiplier de surge.

`GET /health`, `GET /health/ready`, `GET /metrics` quedan fuera del prefijo versionado.

## gRPC (`veo.dispatch.v1.DispatchService`)

- `GetMatch(match_id)` → match (o `found=false`).
- `GetSurge(lat, lon)` → `{ multiplier, zone_id, active }`.

## Desarrollo

```bash
pnpm --filter @veo/dispatch-service exec prisma generate
pnpm --filter @veo/dispatch-service dev
```

### Base de datos / migración

```bash
# Generar el SQL de la migración inicial
pnpm --filter @veo/dispatch-service exec prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20260528120000_init/migration.sql

# Aplicar
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo" \
  pnpm --filter @veo/dispatch-service exec prisma migrate deploy
```

### Seed (zona de surge de ejemplo)

```bash
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo" pnpm --filter @veo/dispatch-service db:seed
```

## Tests

```bash
pnpm --filter @veo/dispatch-service typecheck
pnpm --filter @veo/dispatch-service test            # unit (sin dependencias externas)
RUN_INTEGRATION=1 pnpm --filter @veo/dispatch-service test   # + integración Redis real (testcontainers, requiere Docker)
```

- Unit: scoring (BR-T06), flujo de oferta (timeout + expansión k-ring), surge, exclusión por pánico.
- Integración (gated): `RedisHotIndex` contra Redis real (LUA atómico, TTL, exclusión).

Ver [`docs/events.md`](docs/events.md) para el contrato de eventos y las decisiones de arquitectura.
