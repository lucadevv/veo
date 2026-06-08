-- CreateEnum
CREATE TYPE "payment"."IncentiveType" AS ENUM ('META_VIAJES', 'HORA_PICO');

-- CreateTable
CREATE TABLE "payment"."incentives" (
    "id" UUID NOT NULL,
    "type" "payment"."IncentiveType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "target_trips" INTEGER NOT NULL DEFAULT 0,
    "reward_cents" INTEGER NOT NULL DEFAULT 0,
    "multiplier_bps" INTEGER NOT NULL DEFAULT 0,
    "peak_start_minute" INTEGER,
    "peak_end_minute" INTEGER,
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "incentives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."incentive_progress" (
    "id" UUID NOT NULL,
    "incentive_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "trips_completed" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ,
    "reward_granted_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "incentive_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."incentive_trip_credits" (
    "id" UUID NOT NULL,
    "incentive_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_trip_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incentives_active_idx" ON "payment"."incentives"("active");

-- CreateIndex
CREATE INDEX "incentive_progress_driver_id_idx" ON "payment"."incentive_progress"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_progress_incentive_id_driver_id_key" ON "payment"."incentive_progress"("incentive_id", "driver_id");

-- CreateIndex
CREATE INDEX "incentive_trip_credits_driver_id_trip_id_idx" ON "payment"."incentive_trip_credits"("driver_id", "trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_trip_credits_incentive_id_driver_id_trip_id_key" ON "payment"."incentive_trip_credits"("incentive_id", "driver_id", "trip_id");

-- AddForeignKey
ALTER TABLE "payment"."incentive_progress" ADD CONSTRAINT "incentive_progress_incentive_id_fkey" FOREIGN KEY ("incentive_id") REFERENCES "payment"."incentives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."incentive_trip_credits" ADD CONSTRAINT "incentive_trip_credits_incentive_id_fkey" FOREIGN KEY ("incentive_id") REFERENCES "payment"."incentives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

