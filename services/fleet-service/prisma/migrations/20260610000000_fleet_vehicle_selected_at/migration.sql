-- Lote 2 · Vehículo activo server-authoritative: el conductor SELECCIONA cuál de sus vehículos opera.
-- `selected_at` marca cuándo lo eligió; el activo = el vehículo con `selected_at` más reciente (con docs
-- vigentes). El dispatch deriva el tipo de ESTE vehículo (vía el BFF), no del ping auto-declarado.
-- Ver fleet-service/prisma/schema.prisma.

-- AlterTable
ALTER TABLE "fleet"."vehicles" ADD COLUMN     "selected_at" TIMESTAMPTZ;
