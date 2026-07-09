-- SEAM catálogo↔operabilidad (ADR 013): estado DELTA del consumidor de `catalog.updated`. Singleton que recuerda
-- la última versión del catálogo procesada + el set de clases de vehículo operables en ese momento, para que el
-- consumidor suspenda/reincorpore SOLO a los conductores de la clase que EFECTIVAMENTE cambió (un evento sin cambio
-- de clase no toca holds). `version` monotónica → descarta snapshots stale (idempotencia + reorden at-least-once).

-- CreateTable
CREATE TABLE "fleet"."catalog_operable_state" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "operable_classes" TEXT[],
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "catalog_operable_state_pkey" PRIMARY KEY ("id")
);
