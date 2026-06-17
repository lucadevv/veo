# @veo/trip-service

Ciclo de vida del viaje de VEO: máquina de estados determinista (BR-T02), tarifa inmutable
en céntimos PEN (BR-T01/T05), cancelación con penalización (BR-T03) y modo niño (BR-T07).

Puerto HTTP: **3002** · gRPC: **0.0.0.0:50052** · Swagger: `http://localhost:3002/docs`
API REST bajo `/api/v1`.

## Arquitectura

- **Dominio puro** (`src/trips/domain`): máquina de estados, tarifa y penalización. Sin I/O, 100% testeado.
- **Aplicación** (`src/trips/trips.service.ts`): orquesta transiciones; cada mutación + insert en
  `outbox_events` ocurren en la MISMA transacción Prisma (outbox pattern, FOUNDATION §6).
- **Presentación**: REST (`trips.controller.ts`, protegido por `InternalIdentityGuard` del BFF) y
  gRPC de lectura (`src/grpc/trip.grpc.controller.ts`, `veo.trip.v1`).
- **Puertos**: `@veo/maps` tras un puerto propio seleccionable por `VEO_MAPS_MODE` (`local`/`osrm`).
  NUNCA Google Maps (soberanía §0.7).
- **Eventos**: un relay (`outbox.relay.ts`) drena el outbox a Kafka cada 500ms; un consumidor
  (`dispatch.consumer.ts`) escucha `dispatch.match_found` → ASSIGNED.

## Reglas de negocio

| Regla  | Descripción                                                                    | Dónde                             |
| ------ | ------------------------------------------------------------------------------ | --------------------------------- |
| BR-T01 | Tarifa inmutable salvo cambio de destino aprobado (recalcula + `trip_event`)   | `trips.service.changeDestination` |
| BR-T02 | Máquina de estados determinista; transición inválida → `InvalidTripTransition` | `domain/trip-state-machine.ts`    |
| BR-T03 | Penalización de cancelación (gratis <2min o conductor >5min tarde; si no S/3)  | `domain/cancellation.ts`          |
| BR-T05 | `tarifa = (600 + 120·km + 30·min)·surge [+200 niño]` en céntimos PEN           | `domain/fare.ts`                  |
| BR-T07 | Modo niño: solo `childCodeHash` (bcrypt); validación en el recojo              | `trips.service.start`             |

## Estados (BR-T02)

```
REQUESTED → ASSIGNED → ACCEPTED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED
```

Terminales: `CANCELLED_BY_PASSENGER`, `CANCELLED_BY_DRIVER`, `EXPIRED`, `FAILED`.

## Desarrollo

```bash
# Generar cliente Prisma
pnpm --filter @veo/trip-service exec prisma generate

# Aplicar migraciones (dev)
DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo \
  pnpm --filter @veo/trip-service exec prisma migrate deploy

# Levantar en watch
pnpm --filter @veo/trip-service dev

# Verificación
pnpm --filter @veo/trip-service typecheck
pnpm --filter @veo/trip-service test
```

## Endpoints REST (`/api/v1`)

| Método | Ruta                     | Acción                                                         |
| ------ | ------------------------ | -------------------------------------------------------------- |
| POST   | `/trips`                 | Crear/cotizar (→ REQUESTED). Idempotente vía `Idempotency-Key` |
| GET    | `/trips/:id`             | Obtener viaje                                                  |
| GET    | `/trips/:id/state`       | Solo estado                                                    |
| POST   | `/trips/:id/assign`      | Asignar conductor/vehículo (→ ASSIGNED)                        |
| POST   | `/trips/:id/accept`      | Conductor acepta (→ ACCEPTED)                                  |
| POST   | `/trips/:id/arriving`    | En camino (→ ARRIVING)                                         |
| POST   | `/trips/:id/arrived`     | Llegó al recojo (→ ARRIVED)                                    |
| POST   | `/trips/:id/start`       | Iniciar (valida código niño) (→ IN_PROGRESS)                   |
| POST   | `/trips/:id/complete`    | Finalizar (→ COMPLETED)                                        |
| POST   | `/trips/:id/cancel`      | Cancelar + penalización (BR-T03)                               |
| POST   | `/trips/:id/destination` | Cambio de destino (recalcula tarifa, BR-T01)                   |

Health: `GET /health`, `GET /health/ready` · Métricas: `GET /metrics`.

Ver eventos publicados/consumidos en [`docs/events.md`](./docs/events.md).
