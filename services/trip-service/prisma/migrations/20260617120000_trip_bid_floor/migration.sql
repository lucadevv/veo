-- ADR 010 §9.3 · piso de la PUJA (bid floor) editable en caliente, keyed por (zona, oferta). SINGLETON
-- (espejo de fuel_surcharge_config/energy_catalog): default_floor_cents + overrides JSON [{zone, offeringId,
-- floorCents}] + version (CAS). Reemplaza el escalar global hardcodeado en env (BID_FLOOR_CENTS).
-- Sin fila → el servicio degrada a DEFAULT_BID_FLOOR_CONFIG (piso S/7, sin overrides) = comportamiento previo,
-- así que NO se siembra: la ausencia de fila es el caso por defecto honesto (mismo criterio que mode_schedule).
CREATE TABLE IF NOT EXISTS "trip"."bid_floor_config" (
  "id"                  TEXT NOT NULL,
  "default_floor_cents" INTEGER NOT NULL DEFAULT 700,
  "overrides"           JSONB NOT NULL DEFAULT '[]',
  "version"             INTEGER NOT NULL DEFAULT 0,
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bid_floor_config_pkey" PRIMARY KEY ("id")
);
