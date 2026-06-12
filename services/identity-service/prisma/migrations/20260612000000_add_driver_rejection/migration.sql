-- AlterTable: motivo y momento del rechazo de antecedentes del conductor (fix dead-end del conductor
-- rechazado). Columnas nullables (aditivas, sin default): null = nunca rechazado / re-aprobado / reenviado.
ALTER TABLE "identity"."drivers" ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "rejected_at" TIMESTAMPTZ;
