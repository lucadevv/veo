-- Lote F2.1b · ADR-017 — saca GNV de los tipos de energía de la PLATAFORMA.
-- La energía de plataforma queda en 3 tipos: GASOLINE_90 | DIESEL | ELECTRIC. El combustible REAL del
-- vehículo (GNV, GLP) es del DUEÑO del auto (si convirtió a GNV para ahorrar, es su margen privado) — la
-- plataforma NO lo trackea como tipo de energía. Espejo del enum EnergySource de @veo/shared-types.
--
-- Migración DEFENSIVA: si algún VehicleModelSpec curado viejo guardó 'GNV' en `energy_source`, se migra a
-- 'GASOLINE_90' (la base de referencia; el operador puede re-ajustar). NO toca otras columnas
-- (segment/efficiency/pricing) → CERO impacto de precio. Idempotente: el WHERE solo afecta filas con el
-- valor viejo; tras correr no quedan → re-run = no-op.
UPDATE "fleet"."vehicle_model_specs"
SET "energy_source" = 'GASOLINE_90'
WHERE "energy_source" = 'GNV';
