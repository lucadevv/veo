-- F2 · Penalidad de cancelación del pasajero (BR-T03).
-- payment-service consume `trip.cancelled` (penaltyCents) y la registra como obligación cobrable con el
-- split conductor/plataforma. Idempotente por `trip_id` (UNIQUE): un evento reprocesado no duplica.

-- CreateEnum
CREATE TYPE "payment"."CancellationPenaltyStatus" AS ENUM ('PENDING', 'COLLECTED', 'WAIVED');

-- CreateTable
CREATE TABLE "payment"."cancellation_penalties" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "driver_id" UUID,
    "penalty_cents" INTEGER NOT NULL,
    "driver_compensation_cents" INTEGER NOT NULL,
    "platform_cents" INTEGER NOT NULL,
    "status" "payment"."CancellationPenaltyStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collected_at" TIMESTAMPTZ,

    CONSTRAINT "cancellation_penalties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotencia por viaje)
CREATE UNIQUE INDEX "cancellation_penalties_trip_id_key" ON "payment"."cancellation_penalties"("trip_id");

-- CreateIndex (gate: penalidades PENDING por pasajero)
CREATE INDEX "cancellation_penalties_passenger_id_status_idx" ON "payment"."cancellation_penalties"("passenger_id", "status");
