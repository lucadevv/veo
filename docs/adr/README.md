# Architectural Decision Records (ADRs)

> Cada decisión técnica no-trivial se documenta aquí. ADR = decisión + contexto + alternativas + consecuencias.

## Formato

```markdown
# ADR-NNN · Título corto

**Estado:** Propuesto | Aceptado | Reemplazado por ADR-XXX | Deprecado
**Fecha:** YYYY-MM-DD
**Decisores:** @persona1, @persona2

## Contexto

¿Qué problema resolvemos? ¿Qué restricciones aplican?

## Decisión

¿Qué decidimos hacer?

## Alternativas consideradas

- Opción A — pros / contras
- Opción B — pros / contras

## Consecuencias

¿Qué pasa cuando aplicamos esto? Positivo y negativo.

## Referencias

Links, PRs, papers.
```

## Convenciones

- Numeración incremental: `001-`, `002-`, etc.
- Nombre kebab-case corto y descriptivo
- Nunca borrar un ADR — marcarlo "Reemplazado por" o "Deprecado"
- PR del ADR debe tener label `adr` y aprobación de Tech Lead

## ADRs vigentes

| #                                                  | Título                                                         | Estado                   |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| [001](./001-monorepo-pnpm-turborepo.md)            | Monorepo con pnpm + Turborepo                                  | Aceptado                 |
| [002](./002-nestjs-backend-default.md)             | NestJS como framework backend por defecto                      | Aceptado                 |
| [003](./003-react-native-mobile.md)                | React Native para apps móviles                                 | Aceptado                 |
| [004](./004-postgres-redis-clickhouse.md)          | Postgres + Redis + ClickHouse stack de datos                   | Aceptado                 |
| [005](./005-kafka-eventos-dominio.md)              | Kafka como event bus de dominio                                | Aceptado                 |
| [006](./006-livekit-webrtc.md)                     | LiveKit autohospedado para WebRTC                              | Aceptado                 |
| [007](./007-eks-no-fargate.md)                     | EKS sobre ECS Fargate                                          | Reemplazado (modelo VPS) |
| [008](./008-h3-dispatch.md)                        | H3 hex tiles para dispatch geoespacial                         | Aceptado                 |
| [009](./009-multi-repo-strategy.md)                | Estrategia multi-repo (split inicial)                          | Aceptado                 |
| [010](./010-modelo-puja-negociacion.md)            | Modelo de PUJA (negociación pasajero↔conductor)                | Ratificado · alineado 023 |
| [011](./011-switch-puja-fijo-por-horario.md)       | Switch PUJA/FIJO por horario                                   | Superseded (franjas) → 023 |
| [012](./012-metodos-de-autenticacion-soberanos.md) | Métodos de auth multi-método soberanos                         | Ratificado               |
| [013](./013-catalogo-service-offerings.md)         | Catálogo de service offerings                                  | Ratificado · alineado 023 |
| [014](./014-modelo-carpooling-booking-service.md)  | Carpooling: `booking-service` (marketplace PROGRAMADO)         | Ratificado · naming 023  |
| [015](./015-liquidaciones-payout.md)               | Liquidaciones y payout (`PayoutGateway` money-OUT)             | Ratificado               |
| [016](./016-mtls-grpc-interno.md)                  | mTLS para el gRPC interno (TLS-capable env-gated)              | Aceptado                 |
| [017](./017-modelo-pricing-energia-tiers.md)       | Modelo de pricing, energía y tiers del híbrido (admin primero) | Aceptado · energía removida |
| [023](./023-modelo-pricing-coexistencia.md)        | **Modelo de pricing por COEXISTENCIA (FIJO·PUJA·COST-SHARE)**   | **Ratificado (fuente de verdad)** |
