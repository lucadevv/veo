-- F2.7 · Comisión por MODO (ADR-017 §1.6 / ADR-015 §11.2 · nudo legal). Hoy la comisión es un env GLOBAL 20%
-- aplicado a TODO cobro → el carpooling cobra 20% como on-demand, ILEGAL en cost-sharing. Esta migración:
--   1. Crea el enum PaymentMode (ON_DEMAND | CARPOOLING) y la columna payments.mode (NULLABLE = compat legacy,
--      que se LEE como ON_DEMAND; default ON_DEMAND para filas nuevas sin modo explícito).
--   2. Crea el SINGLETON commission_config (espejo de trip.base_fare_config): la tasa ON-DEMAND editable en
--      caliente, en BASIS POINTS Int (0..10000) — NUNCA float. El carpooling es 0 FIJO de dominio (NO vive acá).

-- 1. Enum del modo de cobro.
CREATE TYPE "payment"."PaymentMode" AS ENUM ('ON_DEMAND', 'CARPOOLING');

-- 2. Columna mode en payments. NULLABLE (filas legacy quedan NULL → se leen como ON_DEMAND en el dominio);
--    DEFAULT ON_DEMAND para que toda fila nueva sin modo explícito arranque en el comportamiento histórico.
ALTER TABLE "payment"."payments" ADD COLUMN "mode" "payment"."PaymentMode" DEFAULT 'ON_DEMAND';

-- 3. Singleton de configuración de comisión. Tasa ON-DEMAND en basis points Int (2000 = 20%, el valor VIGENTE
--    del env COMMISSION_RATE) + version (CAS) + updated_at.
CREATE TABLE IF NOT EXISTS "payment"."commission_config" (
  "id"                 TEXT NOT NULL,
  "on_demand_rate_bps" INTEGER NOT NULL DEFAULT 2000,
  "version"            INTEGER NOT NULL DEFAULT 0,
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commission_config_pkey" PRIMARY KEY ("id")
);

-- Seed NO-breaking: la fila GLOBAL con la tasa VIGENTE (2000 bps = 20%) → CERO cambio de comisión on-demand al
-- desplegar. version=1 (ya hubo un "write" semántico: el seed). Idempotente: solo si el singleton aún no existe.
-- El carpooling NO se siembra: su tasa es 0 FIJO de dominio (CARPOOLING_COMMISSION_BPS), no una fila editable.
INSERT INTO "payment"."commission_config" ("id", "on_demand_rate_bps", "version", "updated_at")
SELECT 'GLOBAL', 2000, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "payment"."commission_config" WHERE "id" = 'GLOBAL');
