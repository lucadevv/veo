-- Sub-lote 3B: agrega DNI al enum FleetDocumentType (documento de identidad del conductor, 2 caras
-- FRONT+BACK vía DocumentImage del 3A). La cara FRONT la consumirá el face-match (sub-lote 3C).
-- ADD VALUE IF NOT EXISTS = idempotente y prod-safe / non-destructivo (no recrea el tipo ni reescribe filas).
ALTER TYPE "fleet"."FleetDocumentType" ADD VALUE IF NOT EXISTS 'DNI';
