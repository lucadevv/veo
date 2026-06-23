-- MODELO DE HOLDS de suspensión del conductor (decisión del dueño · compliance/seguridad).
-- La suspensión deja de ser UN flag colapsado (`suspension_source`) y pasa a ser el CONJUNTO de holds
-- activos (`driver_suspension_holds`): un conductor está suspendido ⟺ tiene ≥1 hold; libre SOLO con 0.
-- Cada causa distinta es un hold separado, así regularizar UNA (ej. SOAT) NUNCA quita las otras (ej. ITV).
-- `drivers.suspended_at` se CONSERVA como campo DERIVADO/mantenido (null ⟺ 0 holds) — ningún lector externo
-- (startShift, eligibility gate de dispatch/booking vía gRPC, badge admin-bff) cambia.

-- CreateEnum
CREATE TYPE "identity"."SuspensionCause" AS ENUM ('DISCIPLINARY', 'DOCUMENT_EXPIRED', 'INSPECTION_EXPIRED');

-- CreateTable
CREATE TABLE "identity"."driver_suspension_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driver_id" UUID NOT NULL,
    "cause" "identity"."SuspensionCause" NOT NULL,
    "cause_ref" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_suspension_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_suspension_holds_driver_id_cause_cause_ref_key"
    ON "identity"."driver_suspension_holds"("driver_id", "cause", "cause_ref");

-- CreateIndex
CREATE INDEX "driver_suspension_holds_driver_id_idx"
    ON "identity"."driver_suspension_holds"("driver_id");

-- AddForeignKey
ALTER TABLE "identity"."driver_suspension_holds"
    ADD CONSTRAINT "driver_suspension_holds_driver_id_fkey"
    FOREIGN KEY ("driver_id") REFERENCES "identity"."drivers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL (cero pérdida de suspensiones vigentes): por cada Driver suspendido HOY (suspended_at != null),
-- crear UN hold equivalente que preserve su suspensión bajo el nuevo modelo. El `created_at` del hold = el
-- `suspended_at` original (así `suspended_at` derivado = el momento original, no se mueve al correr la migración).
--  - suspension_source = DISCIPLINARY    → hold DISCIPLINARY (la levanta reactivate() manual).
--  - suspension_source = DOCUMENT_EXPIRED → hold DOCUMENT_EXPIRED con cause_ref = 'LEGACY': el documentType
--    exacto NO se conoce retroactivamente (el flag viejo lo colapsaba); 'LEGACY' lo mantiene levantable por la
--    vía de compliance (reactivateForCompliance) y por el override del operador. No re-suspende: es 1 hold.
--  - suspension_source NULL pero suspended_at != null (fila legacy de antes del source) → se trata como
--    DISCIPLINARY (posición segura del modelo viejo: un source null se rechazaba en la vía de documento, así
--    que era reversible SOLO por el operador → DISCIPLINARY es la causa equivalente).
INSERT INTO "identity"."driver_suspension_holds" ("driver_id", "cause", "cause_ref", "reason", "created_at")
SELECT
    d."id",
    CASE
        WHEN d."suspension_source" = 'DOCUMENT_EXPIRED' THEN 'DOCUMENT_EXPIRED'::"identity"."SuspensionCause"
        ELSE 'DISCIPLINARY'::"identity"."SuspensionCause"
    END,
    CASE WHEN d."suspension_source" = 'DOCUMENT_EXPIRED' THEN 'LEGACY' ELSE '' END,
    'Migrado del modelo de flag único (suspension_source)',
    d."suspended_at"
FROM "identity"."drivers" d
WHERE d."suspended_at" IS NOT NULL;

-- DROP del flag viejo: su rol lo cumple ahora el `cause` del hold. `suspended_at` se conserva (derivado).
ALTER TABLE "identity"."drivers" DROP COLUMN "suspension_source";

-- DropEnum (ya sin columnas que lo usen)
DROP TYPE "identity"."SuspensionSource";
