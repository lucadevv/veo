-- B5-2 · catálogo curado de modelos de vehículo (make+model+año → seats/segment/combustible/eficiencia).
-- El conductor elige de acá en el onboarding; modelos nuevos entran PENDING_REVIEW y el operador los aprueba.
CREATE TYPE "fleet"."VehicleModelStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

CREATE TABLE IF NOT EXISTS "fleet"."vehicle_model_specs" (
  "id"           UUID NOT NULL,
  "make"         TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "year_from"    INTEGER NOT NULL,
  "year_to"      INTEGER NOT NULL,
  "vehicle_type" "fleet"."VehicleType" NOT NULL DEFAULT 'CAR',
  "seats"        INTEGER NOT NULL,
  "segment"      TEXT NOT NULL,
  "energy_source" TEXT NOT NULL,
  "efficiency"   INTEGER NOT NULL,
  "status"       "fleet"."VehicleModelStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "requested_by" UUID,
  "verified_by"  UUID,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_model_specs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_model_specs_make_model_year_from_key"
  ON "fleet"."vehicle_model_specs" ("make", "model", "year_from");
CREATE INDEX IF NOT EXISTS "vehicle_model_specs_status_idx"
  ON "fleet"."vehicle_model_specs" ("status");

-- Seed: modelos comunes de Lima/Perú, APPROVED (curados con la cifra de fábrica de referencia). Idempotente.
INSERT INTO "fleet"."vehicle_model_specs"
  ("id", "make", "model", "year_from", "year_to", "vehicle_type", "seats", "segment", "energy_source", "efficiency", "status", "verified_by")
VALUES
  (gen_random_uuid(), 'Hyundai', 'i10',     2018, 2024, 'CAR',  5, 'ECONOMY', 'GASOLINE_95', 18, 'APPROVED', NULL),
  (gen_random_uuid(), 'Kia',     'Rio',     2017, 2024, 'CAR',  5, 'ECONOMY', 'GASOLINE_95', 16, 'APPROVED', NULL),
  (gen_random_uuid(), 'Toyota',  'Yaris',   2017, 2024, 'CAR',  5, 'ECONOMY', 'GASOLINE_95', 17, 'APPROVED', NULL),
  (gen_random_uuid(), 'Toyota',  'Corolla', 2018, 2024, 'CAR',  5, 'MID',     'GASOLINE_95', 14, 'APPROVED', NULL),
  (gen_random_uuid(), 'Hyundai', 'Accent',  2017, 2024, 'CAR',  5, 'MID',     'GASOLINE_95', 15, 'APPROVED', NULL),
  (gen_random_uuid(), 'Toyota',  'Avanza',  2018, 2024, 'CAR',  7, 'MID',     'GASOLINE_95', 13, 'APPROVED', NULL),
  (gen_random_uuid(), 'Toyota',  'Hilux',   2018, 2024, 'CAR',  5, 'MID',     'DIESEL',      12, 'APPROVED', NULL),
  (gen_random_uuid(), 'Bajaj',   'RE',      2018, 2024, 'MOTO', 3, 'ECONOMY', 'GASOLINE_95', 35, 'APPROVED', NULL)
ON CONFLICT ("make", "model", "year_from") DO NOTHING;
