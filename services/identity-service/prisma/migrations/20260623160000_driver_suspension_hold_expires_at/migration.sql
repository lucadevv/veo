-- HOLD TEMPORAL (primer hold con expiración del sistema). `expires_at` NULL = PERMANENTE (DISCIPLINARY /
-- DOCUMENT_EXPIRED / INSPECTION_EXPIRED / RATING_LOW): solo lo levanta una vía explícita (operador / fleet /
-- compliance). SETEADO = COOLDOWN auto-expirable (hoy EXCESSIVE_CANCELLATIONS): un sweeper (@Cron en identity)
-- quita el hold cuando `expires_at < now` y recomputa `drivers.suspended_at`. NO se hace expiración LAZY porque
-- `suspended_at` es la columna derivada ÚNICA que leen startShift / dispatch / booking / admin: lazy la dejaría
-- STALE; el sweeper mantiene la verdad derivada. Los holds EXISTENTES quedan con NULL = permanentes (sin cambio
-- de comportamiento para las causas previas).

-- AlterTable
ALTER TABLE "identity"."driver_suspension_holds" ADD COLUMN "expires_at" TIMESTAMPTZ;

-- CreateIndex (hot-path del sweeper: `expires_at < now`; Postgres lo sirve sobre las filas NOT NULL).
CREATE INDEX "driver_suspension_holds_expires_at_idx"
    ON "identity"."driver_suspension_holds"("expires_at");
