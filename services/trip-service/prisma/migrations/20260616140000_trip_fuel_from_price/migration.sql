-- B4 · el recargo de combustible se DERIVA del precio del combustible (lo que el admin ve) y el
-- rendimiento (km/litro), en vez de ingresarse como un per-km ya calculado.
ALTER TABLE "trip"."fuel_surcharge_config" DROP COLUMN IF EXISTS "surcharge_cents_per_km";
ALTER TABLE "trip"."fuel_surcharge_config" ADD COLUMN IF NOT EXISTS "fuel_price_per_liter_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "trip"."fuel_surcharge_config" ADD COLUMN IF NOT EXISTS "km_per_liter" INTEGER NOT NULL DEFAULT 0;
