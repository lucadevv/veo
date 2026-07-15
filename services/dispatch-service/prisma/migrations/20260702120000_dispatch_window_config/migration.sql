-- Ventanas de dispatch editables en runtime por el admin (ADR-019 Lote A): se agregan al singleton
-- dispatch_radius_config las dos ventanas que hoy son ENV-only (requieren restart):
--   offer_timeout_ms → ventana de la oferta directa FIXED (env seed DISPATCH_OFFER_TIMEOUT_MS, 12000)
--   bid_window_sec   → ventana del board de PUJA          (env seed BID_WINDOW_SEC, 60)
-- Columnas NOT NULL: se agregan con DEFAULT para BACKFILL de una fila preexistente (si el admin ya editó
-- radios) y luego se DROPEA el default para quedar consistentes con el schema.prisma (sin @default),
-- igual que nearby_k_ring / match_k_ring. Sin fila → el service degrada al DEFAULT_RADIUS_CONFIG (12000/60).

-- AlterTable
ALTER TABLE "dispatch"."dispatch_radius_config" ADD COLUMN "offer_timeout_ms" INTEGER NOT NULL DEFAULT 12000;
ALTER TABLE "dispatch"."dispatch_radius_config" ADD COLUMN "bid_window_sec" INTEGER NOT NULL DEFAULT 60;

-- Drop de los defaults de backfill: el schema.prisma NO declara @default para estas columnas (el default
-- vive en el DEFAULT_RADIUS_CONFIG del service, no en la DB), así evitamos drift al próximo migrate diff.
ALTER TABLE "dispatch"."dispatch_radius_config" ALTER COLUMN "offer_timeout_ms" DROP DEFAULT;
ALTER TABLE "dispatch"."dispatch_radius_config" ALTER COLUMN "bid_window_sec" DROP DEFAULT;
