-- F5 · key S3/MinIO de la SELFIE del enrol (cifrada en reposo · Ley 29733). ADICIONAL al embedding: ayuda
-- visual para el operador en casos dudosos (la verificación real la hace el match contra DNI/licencia).
-- Nullable (migración segura, sin backfill): null = sin selfie guardada (best-effort, o conductor previo).
-- AlterTable
ALTER TABLE "identity"."drivers"
  ADD COLUMN "face_selfie_key" TEXT;
