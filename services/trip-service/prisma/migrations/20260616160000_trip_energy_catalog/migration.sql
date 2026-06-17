-- B5 · catálogo de precios de energía por fuente (singleton + array JSON). Generaliza el precio global
-- único de combustible (fuel_surcharge_config) a un modelo multi-fuente (gasolina/diesel/GNV/eléctrico).
CREATE TABLE IF NOT EXISTS "trip"."energy_catalog" (
  "id"         TEXT NOT NULL,
  "sources"    JSONB NOT NULL DEFAULT '[]',
  "version"    INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "energy_catalog_pkey" PRIMARY KEY ("id")
);

-- Seed NO-breaking: GASOLINE_95 = el precio global vigente del fuel_surcharge_config (caso degenerado de
-- 1 fuente → multi-fuente). Idempotente: solo si el singleton aún no existe.
INSERT INTO "trip"."energy_catalog" ("id", "sources", "version", "updated_at")
SELECT 'GLOBAL',
       jsonb_build_array(jsonb_build_object(
         'sourceId', 'GASOLINE_95',
         'unit', 'LITER',
         'pricePerUnitCents', COALESCE(
           (SELECT "fuel_price_per_liter_cents" FROM "trip"."fuel_surcharge_config" WHERE "id" = 'GLOBAL'),
           0
         )
       )),
       1,
       CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "trip"."energy_catalog" WHERE "id" = 'GLOBAL');
