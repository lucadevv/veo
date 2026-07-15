-- F2.5 · Costo/km DIRECTO editable por el admin (per-país) + peaje declarado por el conductor.
-- Reescribe el cost-cap del carpooling al modelo BlaBlaCar: el costo/km es el costo de OPERACIÓN real
-- (combustible + desgaste), FIJADO por el admin (NO derivado del precio de energía); el peaje (tolls_cents)
-- lo declara el conductor por viaje y se SUMA al costo antes de repartir entre asientos.

-- 1) Peaje del viaje en published_trips. ADD COLUMN con DEFAULT 0 (constante, NO volátil) → en PG16 es
--    metadata-only (no reescribe la tabla): las filas existentes leen el default sin rewrite. Las ofertas
--    legacy nacen con peaje 0 (sin peaje), coherente con el comportamiento previo (no había peaje).
ALTER TABLE "booking"."published_trips" ADD COLUMN "tolls_cents" INTEGER NOT NULL DEFAULT 0;

-- 2) Tabla de config del costo/km, POR PAÍS (PK = pais). Cada país versiona su tarifa por separado (CAS).
CREATE TABLE "booking"."cost_per_km_config" (
    "pais" TEXT NOT NULL,
    "cost_per_km_cents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_per_km_config_pkey" PRIMARY KEY ("pais")
);

-- 3) Seed: PE = 150 céntimos (S/1.50/km, el valor real del dueño = combustible + desgaste); EC = 50
--    (placeholder hasta F8). version 0 = primer estado (el PUT del admin sube a 1 con CAS). Idempotente:
--    ON CONFLICT DO NOTHING para no pisar un valor ya editado si la migración re-corre en un entorno raro.
INSERT INTO "booking"."cost_per_km_config" ("pais", "cost_per_km_cents", "version", "updated_at")
VALUES
    ('PE', 150, 0, CURRENT_TIMESTAMP),
    ('EC', 50, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("pais") DO NOTHING;
