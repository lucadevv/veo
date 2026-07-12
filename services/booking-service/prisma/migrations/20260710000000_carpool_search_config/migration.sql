-- F2 · Radio de BÚSQUEDA del carpooling, editable EN CALIENTE por el admin (singleton GLOBAL).
-- Espeja dispatch_radius_config: una sola fila (id='GLOBAL') con version CAS. Los radios se guardan en KM
-- (unidad del admin) y se mapean a k-rings H3 res-9 en runtime (~0.3km/anillo). Additive: no toca ninguna
-- tabla existente. El env SEARCH_H3_K_RING/_EXPAND queda como FALLBACK de degradación honesta.

-- 1) Tabla de config del radio de búsqueda (singleton). version 0 = primer estado (el PUT sube a 1 con CAS).
CREATE TABLE "booking"."carpool_search_config" (
    "id" TEXT NOT NULL,
    "base_radius_km" DOUBLE PRECISION NOT NULL,
    "expand_radius_km" DOUBLE PRECISION NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carpool_search_config_pkey" PRIMARY KEY ("id")
);

-- 2) Seed del singleton GLOBAL: base=0.3km (k1) / expand=0.6km (k2) — equivalente a los defaults env
--    SEARCH_H3_K_RING=1 / SEARCH_H3_K_RING_EXPAND=2 (env = seed del default de la DB). Idempotente:
--    ON CONFLICT DO NOTHING para no pisar un valor ya editado si la migración re-corre en un entorno raro.
INSERT INTO "booking"."carpool_search_config" ("id", "base_radius_km", "expand_radius_km", "version", "updated_at")
VALUES ('GLOBAL', 0.3, 0.6, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
