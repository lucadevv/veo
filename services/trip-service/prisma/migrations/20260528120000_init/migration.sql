-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "trip";

-- CreateEnum
CREATE TYPE "trip"."TripStatus" AS ENUM ('REQUESTED', 'ASSIGNED', 'ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "trip"."PaymentMethod" AS ENUM ('YAPE', 'PLIN', 'CASH', 'CARD');

-- CreateEnum
CREATE TYPE "trip"."CancelledBy" AS ENUM ('PASSENGER', 'DRIVER', 'SYSTEM');

-- CreateTable
CREATE TABLE "trip"."trips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "passenger_id" UUID NOT NULL,
    "driver_id" UUID,
    "vehicle_id" UUID,
    "origin_lat" DOUBLE PRECISION NOT NULL,
    "origin_lon" DOUBLE PRECISION NOT NULL,
    "dest_lat" DOUBLE PRECISION NOT NULL,
    "dest_lon" DOUBLE PRECISION NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "arriving_at" TIMESTAMPTZ,
    "arrived_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "fare_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "surge_multiplier" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "distance_meters" INTEGER NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "payment_method" "trip"."PaymentMethod" NOT NULL,
    "status" "trip"."TripStatus" NOT NULL DEFAULT 'REQUESTED',
    "route_polyline" TEXT,
    "child_mode" BOOLEAN NOT NULL DEFAULT false,
    "child_code_hash" TEXT,
    "cancelled_by" "trip"."CancelledBy",
    "cancellation_reason" TEXT,
    "penalty_cents" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip"."trip_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trips_idempotency_key_key" ON "trip"."trips"("idempotency_key");

-- CreateIndex
CREATE INDEX "trips_passenger_id_requested_at_idx" ON "trip"."trips"("passenger_id", "requested_at");

-- CreateIndex
CREATE INDEX "trips_driver_id_status_idx" ON "trip"."trips"("driver_id", "status");

-- CreateIndex
CREATE INDEX "trips_status_idx" ON "trip"."trips"("status");

-- CreateIndex
CREATE INDEX "trip_events_trip_id_occurred_at_idx" ON "trip"."trip_events"("trip_id", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "trip"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "trip"."trip_events" ADD CONSTRAINT "trip_events_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"."trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

