-- Ola siguiente · Onboarding self-service: el conductor registra su propio vehículo.
-- Asocia el vehículo al conductor (driver_id = id de identity-service, sin FK cross-schema) y
-- permite rehidratar la flota del conductor. El alta queda pendiente de verificación (active=false).
-- Ver fleet-service/prisma/schema.prisma.

-- AlterTable
ALTER TABLE "fleet"."vehicles" ADD COLUMN     "driver_id" UUID;

-- CreateIndex
CREATE INDEX "vehicles_driver_id_idx" ON "fleet"."vehicles"("driver_id");
