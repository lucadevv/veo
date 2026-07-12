-- ADR 013 · Ofertas CUSTOM (alta del admin en caliente). EXTIENDE el enum OfferingId de @veo/shared-types:
-- los built-in viven en código (OFFERINGS), las custom en esta tabla. Restricción HONESTA: `vehicle_class` y
-- `service_type` son tipos que YA EXISTEN (el dispatch/matching trabaja por vehicle_class — NO se inventa un
-- tipo de vehículo). El catálogo efectivo (CatalogService.getCatalog) UNE built-in ∪ custom; el overlay del
-- admin (offering_catalog) configura ambas igual. `mode`/`multiplier`/`min_fare_cents`/`enabled` son los valores
-- INICIALES (el overlay los pisa). Crearla es acción de SUPERADMIN + step-up MFA (admin-bff), auditada.
--
-- `vehicle_class` reusa el enum "trip"."VehicleType" (CAR|MOTO) y `mode` el "trip"."PricingMode" (PUJA|FIXED)
-- — mismos tipos que la tabla Trip, sin inventar enums nuevos. `service_type` es TEXT (el enum canónico
-- ServiceType vive en shared-types; se valida en la app). Idempotente (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "trip"."custom_offering" (
  "id"             TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "vehicle_class"  "trip"."VehicleType" NOT NULL,
  "service_type"   TEXT NOT NULL,
  "mode"           "trip"."PricingMode" NOT NULL,
  "multiplier"     DOUBLE PRECISION NOT NULL,
  "min_fare_cents" INTEGER NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "created_by"     TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custom_offering_pkey" PRIMARY KEY ("id")
);
