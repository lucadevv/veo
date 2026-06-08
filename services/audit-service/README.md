# @veo/audit-service

Log de auditoría **inmutable** de VEO (movilidad segura · Lima · **Ley 29733**).

- **Append-only** con **hash chain** real (`chainHash` de `@veo/utils`): cada entrada encadena el
  hash de la anterior → manipulación detectable de forma determinista.
- **Inmutabilidad en profundidad**: triggers Postgres que rechazan `UPDATE`/`DELETE`
  (`s3_object_key` es la única columna *write-once*) + réplica **WORM** a **S3 Object Lock**
  (modo `COMPLIANCE`) sobre MinIO self-hosted en dev.
- Principalmente **consume** los eventos auditables del dominio (ver [`docs/events.md`](docs/events.md)).

Puerto local: **3009** (HTTP) · gRPC **0.0.0.0:50059** · Swagger: `http://localhost:3009/docs`
· Prefijo API: `/api/v1` · Health: `/api/v1/health` y `/api/v1/health/ready` · Métricas: `/api/v1/metrics`

## Arquitectura

```
src/
  config/env.schema.ts        Validación de entorno (zod)
  infra/
    prisma.service.ts         ReadWriteClient (read/write split)
    core.module.ts            DI global: Prisma, secreto interno, guards (RBAC)
    outbox.relay.ts           Drena outbox → Kafka (audit.recorded)
  audit/
    chain.ts                  Hash chain PURO: serialize + computeEntryHash + verifyChain
    audit.repository.ts       Append-only (advisory lock → orden estricto), consultas, rango
    audit.service.ts          Orquesta registro y verificación de integridad
    audit.controller.ts       REST (POST /audit, GET /audit, GET /audit/verify)
    dto/audit.dto.ts          DTOs + Swagger
  storage/
    object-lock.store.ts      S3/MinIO con Object Lock (COMPLIANCE)
    s3-replication.relay.ts   Réplica WORM (patrón outbox: entradas con s3ObjectKey=null)
    storage.module.ts         Provee el almacén WORM (global)
  consumers/
    audit.consumer.ts         KafkaEventConsumer de eventos auditables
  grpc/
    audit.grpc.controller.ts  veo.audit.v1 (Record, Verify)
prisma/                       schema.prisma (schema "audit") + migración con triggers append-only
proto/audit.proto            Contrato gRPC veo.audit.v1
```

### Garantía de integridad

`hash = chainHash(prevHash, serialize(content))`, donde `serialize` es una serialización
**canónica** (claves ordenadas, `occurredAt` en ISO-8601) → estable tras round-trip por JSONB.
El verificador (`verifyChain`) recorre la cadena ordenada por `seq` y detecta:

- `CONTENT_TAMPERED`: el hash recomputado de una fila no coincide (campo alterado).
- `BROKEN_LINK`: el `prevHash` de una fila no coincide con el `hash` de la anterior (fila borrada/insertada).
- `GENESIS_PREV_HASH`: la primera entrada de una verificación completa no tiene `prevHash = null`.

El `seq` (bigserial) es la fuente de verdad del orden; el append se serializa con
`pg_advisory_xact_lock` para que `prevHash` sea siempre el hash de la última entrada incluso con
writers concurrentes.

## Endpoints REST (`/api/v1`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/audit` | `InternalIdentityGuard` | Registrar una acción auditable (síncrona) |
| `GET` | `/audit` | RBAC `COMPLIANCE_SUPERVISOR` / `SUPERADMIN` | Consultar (filtros `resourceType`, `resourceId`, `actorId`, `action`, `limit`, `beforeSeq`) |
| `GET` | `/audit/verify` | RBAC `COMPLIANCE_SUPERVISOR` / `SUPERADMIN` | Verificar integridad de la cadena en `[fromSeq, toSeq]` |

gRPC `veo.audit.v1.AuditService`: `Record`, `Verify`.

## Desarrollo

Requiere el dev-stack (`pnpm infra:up`): Postgres `5433`, Kafka `9094`, MinIO `9002`.

```bash
# Migración (schema "audit")
DATABASE_URL="postgresql://veo:veo_dev@localhost:5433/veo?schema=audit" pnpm --filter @veo/audit-service db:migrate
pnpm --filter @veo/audit-service codegen      # prisma generate
pnpm --filter @veo/audit-service dev          # arranca el servicio

pnpm --filter @veo/audit-service typecheck
pnpm --filter @veo/audit-service test         # unit (chain) + e2e (testcontainers) + MinIO
```

### Variables de entorno

`DATABASE_URL` (req), `DATABASE_URL_REPLICA`, `KAFKA_BROKERS` (`localhost:9094`), `KAFKA_GROUP_ID`,
`KAFKA_FROM_BEGINNING`, `INTERNAL_IDENTITY_SECRET`, `GRPC_URL` (`0.0.0.0:50059`),
`AUDIT_S3_ENABLED`, `AUDIT_S3_ENDPOINT` (`http://localhost:9002`), `AUDIT_S3_BUCKET`
(`veo-audit-log`), `AUDIT_S3_ACCESS_KEY` (`veo_dev`), `AUDIT_S3_SECRET_KEY` (`veo_dev_secret`),
`AUDIT_S3_FORCE_PATH_STYLE` (`true`), `AUDIT_S3_RETENTION_DAYS` (`2557` ≈ 7 años),
`AUDIT_S3_RELAY_INTERVAL_MS`.

## Tests

- `src/audit/chain.spec.ts` — unit puro: cadena válida + detección de tampering (contenido, enlace).
- `src/audit/audit.e2e.spec.ts` — **testcontainers Postgres real** (sin mocks): N entradas,
  verificación, idempotencia, triggers append-only (`UPDATE`/`DELETE` rechazados), y detección de
  tampering deshabilitando triggers (breach de superusuario).
- `src/storage/object-lock.store.spec.ts` — **MinIO real**: bucket con Object Lock, escritura WORM
  y borrado rechazado por retención `COMPLIANCE`.
