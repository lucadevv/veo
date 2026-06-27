-- F2.4 · Tarifa base GLOBAL (banderazo + per-km + per-min) editable en caliente por el admin. SINGLETON
-- (espejo de fuel_surcharge_config/bid_floor_config): tres componentes Int en céntimos PEN + version (CAS)
-- + updated_at. Reemplaza los escalares hardcodeados en domain/fare.ts (BASE_FARE_CENTS=600, PER_KM_CENTS=120,
-- PER_MIN_CENTS=30). Los defaults de columna son esos mismos valores → toda fila que se cree arranca igual.
CREATE TABLE IF NOT EXISTS "trip"."base_fare_config" (
  "id"              TEXT NOT NULL,
  "base_fare_cents" INTEGER NOT NULL DEFAULT 600,
  "per_km_cents"    INTEGER NOT NULL DEFAULT 120,
  "per_min_cents"   INTEGER NOT NULL DEFAULT 30,
  "version"         INTEGER NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "base_fare_config_pkey" PRIMARY KEY ("id")
);

-- Seed NO-breaking: la fila GLOBAL con los valores VIGENTES (600/120/30) → CERO cambio de precio al
-- desplegar (a diferencia de bid_floor/mode_schedule, que degradan a un default en código, acá SÍ sembramos
-- porque la tarifa base sin fila sería S/0 = viajes gratis, un default peligroso). version=1 (ya hubo un
-- "write" semántico: el seed). Idempotente: solo si el singleton aún no existe.
INSERT INTO "trip"."base_fare_config" ("id", "base_fare_cents", "per_km_cents", "per_min_cents", "version", "updated_at")
SELECT 'GLOBAL', 600, 120, 30, 1, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "trip"."base_fare_config" WHERE "id" = 'GLOBAL');
