-- Lote F2.1a · ADR-017 §1.1 — unifica las gasolinas con octanaje a UNA sola referencia GASOLINE_90.
-- El VehicleModelSpec guarda el combustible del modelo en la columna `energy_source` (texto, espejo del
-- enum EnergySource de @veo/shared-types). Esta migración renombra el valor viejo 'GASOLINE_95'/'GASOLINE_84'
-- → 'GASOLINE_90'. NO toca otras columnas (segment/efficiency/pricing) → CERO impacto de precio.
--
-- La migración seed vieja (20260616170000) NO se edita (ya aplicada): siembra modelos con GASOLINE_95;
-- esta migración de datos los corrige aguas abajo. Idempotente: el WHERE solo afecta filas con el valor
-- viejo; tras correr no quedan → re-run = no-op.
UPDATE "fleet"."vehicle_model_specs"
SET "energy_source" = 'GASOLINE_90'
WHERE "energy_source" IN ('GASOLINE_95', 'GASOLINE_84');
