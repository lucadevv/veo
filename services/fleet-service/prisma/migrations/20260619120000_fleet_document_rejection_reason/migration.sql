-- M5: motivo de rechazo del documento que escribe el operador (el conductor lo VE para saber qué corregir).
-- Nullable: null = no rechazado o sin motivo (degradación honesta). ADD COLUMN IF NOT EXISTS = idempotente.
ALTER TABLE "fleet"."fleet_documents" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
