-- D2.1 · Matching secuencial event-driven (FIXED): estado durable del process-manager.
-- Reemplaza el estado en proceso (Map + Promise + timer) del matcher legacy por una fila por viaje.
-- El advance (offerNext) lee origen/vehículo/k-ring desde aquí para ofertar al siguiente candidato
-- desde cualquier réplica, sin el evento original. Los cierres son CAS atómicos sobre `status`.

-- CreateEnum
CREATE TYPE "dispatch"."VehicleType" AS ENUM ('CAR', 'MOTO');

-- CreateEnum
CREATE TYPE "dispatch"."DispatchSessionStatus" AS ENUM ('OPEN', 'MATCHED', 'TIMED_OUT', 'CANCELLED');

-- CreateTable
CREATE TABLE "dispatch"."dispatch_sessions" (
    "trip_id" UUID NOT NULL,
    "status" "dispatch"."DispatchSessionStatus" NOT NULL DEFAULT 'OPEN',
    "origin_lat" DOUBLE PRECISION NOT NULL,
    "origin_lon" DOUBLE PRECISION NOT NULL,
    "vehicle_type" "dispatch"."VehicleType" NOT NULL DEFAULT 'CAR',
    "current_k_ring" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dispatch_sessions_pkey" PRIMARY KEY ("trip_id")
);

-- CreateIndex (reconciler/cierres consultan por status)
CREATE INDEX "dispatch_sessions_status_idx" ON "dispatch"."dispatch_sessions"("status");
