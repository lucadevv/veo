-- LOTE 3 · el catálogo de modelos CRECE de los registros reales (OCR a texto libre) sin ensuciarse, vía
-- fuzzy-match. Migración ADITIVA (no rompe lo existente):
--   1) pg_trgm para similarity()/% (fuzzy-match por trigramas).
--   2) columnas normalizadas GENERADAS (uppercase + trim + colapso de espacios + sin tildes) — auto-mantenidas
--      por Postgres (GENERATED ALWAYS ... STORED), determinísticas (translate/regexp_replace/upper/trim son
--      IMMUTABLE, a diferencia de unaccent() que NO lo es → no indexable). El código TS replica la MISMA
--      normalización para parametrizar el query (consistencia cliente/DB).
--   3) índices GIN trigram sobre las columnas normalizadas → similarity()/% rápidos.
--   4) `source` del alta (SEED|DRIVER_REQUEST|OCR) para distinguir de dónde vino cada modelo. Sin string
--      mágico: enum tipado. Default DRIVER_REQUEST para las filas existentes (eran solicitudes de conductor
--      o seeds históricos; el seed B5-2 se re-marca explícito abajo a SEED).

-- 1) Extensión de trigramas (idempotente). WITH SCHEMA fleet EXPLÍCITO: pg_trgm (similarity()/%) vive en el
--    schema `fleet`, NO depende del search_path de la conexión. Sin esto, en un deploy fresco la extensión caería
--    en el primer schema del search_path (típicamente public) y `fleet.similarity()` del fuzzy-match no resolvería.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA fleet;

-- 4) Origen del alta del modelo (tipado fuerte, sin string mágico).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'VehicleModelSource' AND n.nspname = 'fleet') THEN
    CREATE TYPE "fleet"."VehicleModelSource" AS ENUM ('SEED', 'DRIVER_REQUEST', 'OCR');
  END IF;
END$$;

ALTER TABLE "fleet"."vehicle_model_specs"
  ADD COLUMN IF NOT EXISTS "source" "fleet"."VehicleModelSource" NOT NULL DEFAULT 'DRIVER_REQUEST';

-- Las filas seedeadas por el operador (B5-2: APPROVED sin requestedBy) son SEED, no solicitudes de conductor.
-- Distinción honesta del origen para las filas pre-existentes.
UPDATE "fleet"."vehicle_model_specs"
  SET "source" = 'SEED'
  WHERE "status" = 'APPROVED' AND "requested_by" IS NULL AND "source" = 'DRIVER_REQUEST';

-- 2) Columnas normalizadas GENERADAS (idempotentes). upper(trim(colapsa-espacios(sin-tildes(col)))).
ALTER TABLE "fleet"."vehicle_model_specs"
  ADD COLUMN IF NOT EXISTS "make_norm" TEXT
    GENERATED ALWAYS AS (
      upper(regexp_replace(trim(translate("make",
        'áéíóúàèìòùäëïöüâêîôûñçÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇ',
        'aeiouaeiouaeiouaeiouncAEIOUAEIOUAEIOUAEIOUNC')), '\s+', ' ', 'g'))
    ) STORED;

ALTER TABLE "fleet"."vehicle_model_specs"
  ADD COLUMN IF NOT EXISTS "model_norm" TEXT
    GENERATED ALWAYS AS (
      upper(regexp_replace(trim(translate("model",
        'áéíóúàèìòùäëïöüâêîôûñçÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇ',
        'aeiouaeiouaeiouaeiouncAEIOUAEIOUAEIOUAEIOUNC')), '\s+', ' ', 'g'))
    ) STORED;

-- 3) Índices GIN trigram sobre las normalizadas (idempotentes) → similarity()/% no hacen seq-scan.
CREATE INDEX IF NOT EXISTS "vehicle_model_specs_make_norm_trgm_idx"
  ON "fleet"."vehicle_model_specs" USING GIN ("make_norm" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "vehicle_model_specs_model_norm_trgm_idx"
  ON "fleet"."vehicle_model_specs" USING GIN ("model_norm" gin_trgm_ops);
