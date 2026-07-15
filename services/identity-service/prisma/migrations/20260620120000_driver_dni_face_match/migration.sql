-- Sub-lote 3C · BINDING DNI↔selfie. Resultado del face-match entre la foto FRONT del DNI y el
-- faceEmbedding de referencia guardado del conductor. Campos NULLABLE (migración segura, sin backfill):
-- null = el match aún no se corrió. El operador VE el binding antes de aprobar.
-- AlterTable
ALTER TABLE "identity"."drivers"
  ADD COLUMN "dni_face_matched"      BOOLEAN,
  ADD COLUMN "dni_face_match_score"  DOUBLE PRECISION,
  ADD COLUMN "dni_face_matched_at"   TIMESTAMPTZ;
