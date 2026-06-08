# ADR-004 · Stack de datos: Postgres + Redis + ClickHouse

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto
Necesitamos transaccional (trips, payments), hot index (dispatch, presence), y analytics (GPS, eventos producto).

## Decisión
- **Postgres 16 + PostGIS**: núcleo transaccional + reportería geoespacial
- **Redis 7 cluster**: cache, pub/sub, dispatch hot index, Socket.IO adapter
- **ClickHouse** (managed Altinity): analytics + GPS history + producto events

## Alternativas
- **DynamoDB**: vendor lock-in pesado, patrones de query aún no claros
- **MongoDB**: relaciones User↔Trip↔Payment↔Driver son fuertemente relacionales
- **TimescaleDB en lugar de ClickHouse**: extension de Postgres pero menor compresión y throughput a 1M+ rows/s

## Consecuencias
+ Cada uno hace lo que mejor sabe
+ Postgres + JSONB cubre flexibilidad sin perder joins
+ ClickHouse 10× compresión y 100× query OLAP
- 3 sistemas que operar (mitigado con managed: RDS, ElastiCache, Altinity)
