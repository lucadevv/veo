-- Ola 2B · Viajes programados (SCHEDULED + scheduled_for/activated_at), paradas múltiples
-- (waypoints JSON) y tier moto-taxi (vehicle_type). Ver trip-service/prisma/schema.prisma.

-- CreateEnum
CREATE TYPE "trip"."VehicleType" AS ENUM ('CAR', 'MOTO');

-- AlterEnum: nuevo estado SCHEDULED (estado inicial de un viaje programado).
ALTER TYPE "trip"."TripStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN     "activated_at" TIMESTAMPTZ,
ADD COLUMN     "scheduled_for" TIMESTAMPTZ,
ADD COLUMN     "vehicle_type" "trip"."VehicleType" NOT NULL DEFAULT 'CAR',
ADD COLUMN     "waypoints" JSONB;

-- CreateIndex
CREATE INDEX "trips_status_scheduled_for_idx" ON "trip"."trips"("status", "scheduled_for");
