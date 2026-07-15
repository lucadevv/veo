-- Onboarding sin-formularios (Lote 0): persiste la data extraída por OCR on-device de cada documento.
-- Antes el OCR corría en el cliente y la data se descartaba (nunca llegaba al backend). Ahora el alta de
-- documento (FleetDocument) la guarda para que el operador la VEA y la RE-VERIFIQUE antes de aprobar.
--
-- Las 3 columnas son NULLABLE y ADITIVAS → backward-compatible: un documento registrado SIN OCR (camino
-- legacy o sin extracción) sigue siendo válido (las columnas quedan NULL). No reescribe ni rompe filas
-- existentes. ADD COLUMN IF NOT EXISTS = idempotente y prod-safe (re-aplicable sin fallar).
--   - extracted_data (JSONB): contrato tipado ExtractedDocumentData de @veo/shared-types (unión por type).
--   - ocr_engine (TEXT): motor que produjo la data (ej. "mlkit-android"). Trazabilidad.
--   - ocr_at (TIMESTAMPTZ): instante de la extracción on-device.
ALTER TABLE "fleet"."fleet_documents" ADD COLUMN IF NOT EXISTS "extracted_data" JSONB;
ALTER TABLE "fleet"."fleet_documents" ADD COLUMN IF NOT EXISTS "ocr_engine" TEXT;
ALTER TABLE "fleet"."fleet_documents" ADD COLUMN IF NOT EXISTS "ocr_at" TIMESTAMPTZ;
