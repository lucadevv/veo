# ADR-008 · H3 hex tiles para dispatch geoespacial

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto

Match pasajero↔conductor a 950 trips/hora peak con 600 conductores online. PostGIS sufre por lock contention en el hot path.

## Decisión

**H3 (Uber)** resolución 9 (~170m radio) + Redis SET con SADD/SREM atómicos en Lua. PostGIS queda para zonas (surge, geofences), no hot path.

## Alternativas

- **PostGIS ST_DWithin**: lock contention a > 500 drivers online
- **S2 (Google)**: menos ecosistema TypeScript/Go
- **GeoHash + Redis GEO**: precisión variable, queries más complejas

## Consecuencias

- O(1) lookup en Redis
- Scoring trivial post-candidatos
- Compatible con Uber/Lyft research

* Tile size fijo (mitigado: k-ring para radio variable)
* Una capa más que aprender
