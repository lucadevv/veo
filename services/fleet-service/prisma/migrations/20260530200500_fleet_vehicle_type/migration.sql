-- Ola 2B · Tier moto-taxi: tipo de vehículo (CAR|MOTO) en la flota. dispatch filtra el matching
-- por este tipo. Default CAR para no romper la flota existente. Ver fleet-service/prisma/schema.prisma.

-- CreateEnum
CREATE TYPE "fleet"."VehicleType" AS ENUM ('CAR', 'MOTO');

-- AlterTable
ALTER TABLE "fleet"."vehicles" ADD COLUMN     "vehicle_type" "fleet"."VehicleType" NOT NULL DEFAULT 'CAR';
