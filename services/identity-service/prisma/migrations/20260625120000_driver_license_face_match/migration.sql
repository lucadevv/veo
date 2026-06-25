-- Lote C · BINDING licencia↔selfie (gemelo del DNI, binding MÁS FUERTE). Face-match entre la foto del
-- brevete (LICENSE_A1) y el faceEmbedding de referencia guardado del conductor. Campos NULLABLE (migración
-- segura, sin backfill): null = el match aún no se corrió. El operador VE el binding antes de aprobar.
-- approve() exige que AMBOS bindings (DNI y licencia) se hayan EJECUTADO antes de habilitar.
-- AlterTable
ALTER TABLE "identity"."drivers"
  ADD COLUMN "license_face_matched"      BOOLEAN,
  ADD COLUMN "license_face_match_score"  DOUBLE PRECISION,
  ADD COLUMN "license_face_matched_at"   TIMESTAMPTZ;
