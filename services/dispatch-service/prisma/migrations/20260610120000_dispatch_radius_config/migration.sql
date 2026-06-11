-- Config SINGLETON de RADIOS de dispatch (k-rings) editable en runtime por el admin.
-- Espejo del pricing_mode_schedule del trip-service: UNA fila (id='GLOBAL'), `version` bumpeado en cada
-- PUT (auditable + dedupe del evento dispatch.radius_config_updated). Sin fila → el service degrada al
-- DEFAULT_RADIUS_CONFIG (version 0). No se siembra fila acá: el GET/PUT del admin la materializa (upsert).

-- CreateTable
CREATE TABLE "dispatch"."dispatch_radius_config" (
    "id" TEXT NOT NULL,
    "nearby_k_ring" INTEGER NOT NULL,
    "match_k_ring" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dispatch_radius_config_pkey" PRIMARY KEY ("id")
);
