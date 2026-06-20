-- Sub-lote 3A · MÚLTIPLES IMÁGENES por documento (hoy 1 imagen singular en `file_s3_key`).
-- Habilita DNI anverso+reverso (FRONT+BACK) y N fotos de vehículo (SINGLE + order).
--
-- Migración SEGURA y backward-compat:
--   1. Crea el enum `DocumentSide` (FRONT|BACK|SINGLE) — tipado, sin string suelto.
--   2. Crea la tabla `document_images` (1-a-N con fleet_documents, FK onDelete Cascade).
--   3. BACKFILL: cada fleet_document con file_s3_key no-null → una fila DocumentImage(side=SINGLE, order=0).
--   4. NO toca `file_s3_key` (se conserva DEPRECADO por backward-compat — se borra en un lote futuro).
-- Idempotente donde aplica (IF NOT EXISTS); el backfill usa NOT EXISTS para no duplicar si se re-corre.

-- 1. Enum DocumentSide (en el schema lógico fleet).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'DocumentSide' AND n.nspname = 'fleet'
  ) THEN
    CREATE TYPE "fleet"."DocumentSide" AS ENUM ('FRONT', 'BACK', 'SINGLE');
  END IF;
END$$;

-- 2. Tabla document_images.
CREATE TABLE IF NOT EXISTS "fleet"."document_images" (
  "id"          UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "s3_key"      TEXT NOT NULL,
  "side"        "fleet"."DocumentSide" NOT NULL,
  "order"       INTEGER NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_images_pkey" PRIMARY KEY ("id")
);

-- Índice (document_id, order): lectura ordenada del set de imágenes de un documento.
CREATE INDEX IF NOT EXISTS "document_images_document_id_order_idx"
  ON "fleet"."document_images" ("document_id", "order");

-- FK a fleet_documents con onDelete Cascade (borrar el doc borra sus imágenes). Idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_images_document_id_fkey'
  ) THEN
    ALTER TABLE "fleet"."document_images"
      ADD CONSTRAINT "document_images_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "fleet"."fleet_documents"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- 3. BACKFILL: documentos existentes con file_s3_key → una imagen SINGLE order 0. id determinista
-- (gen_random_uuid) por fila. NOT EXISTS evita duplicar si la migración se re-aplica sobre datos ya backfilleados.
INSERT INTO "fleet"."document_images" ("id", "document_id", "s3_key", "side", "order", "created_at")
SELECT gen_random_uuid(), d."id", d."file_s3_key", 'SINGLE'::"fleet"."DocumentSide", 0, d."created_at"
FROM "fleet"."fleet_documents" d
WHERE d."file_s3_key" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "fleet"."document_images" di WHERE di."document_id" = d."id"
  );
