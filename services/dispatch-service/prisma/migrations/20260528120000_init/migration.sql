-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "dispatch";

-- CreateEnum
CREATE TYPE "dispatch"."DispatchOutcome" AS ENUM ('OFFERED', 'ACCEPTED', 'REJECTED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "dispatch"."dispatch_matches" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "score" DECIMAL(12,6) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "surge_multiplier" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "outcome" "dispatch"."DispatchOutcome" NOT NULL DEFAULT 'OFFERED',
    "offered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ,

    CONSTRAINT "dispatch_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch"."surge_zones" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cells" JSONB NOT NULL DEFAULT '[]',
    "min_lat" DOUBLE PRECISION,
    "max_lat" DOUBLE PRECISION,
    "min_lon" DOUBLE PRECISION,
    "max_lon" DOUBLE PRECISION,
    "demand_supply_threshold" DECIMAL(6,2) NOT NULL,
    "multiplier" DECIMAL(3,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "surge_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch"."driver_stats" (
    "driver_id" UUID NOT NULL,
    "avg_rating" DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "completed_trips" INTEGER NOT NULL DEFAULT 0,
    "cancelled_trips" INTEGER NOT NULL DEFAULT 0,
    "last_trip_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "driver_stats_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "dispatch"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_matches_trip_id_idx" ON "dispatch"."dispatch_matches"("trip_id");

-- CreateIndex
CREATE INDEX "dispatch_matches_driver_id_idx" ON "dispatch"."dispatch_matches"("driver_id");

-- CreateIndex
CREATE INDEX "dispatch_matches_trip_id_outcome_idx" ON "dispatch"."dispatch_matches"("trip_id", "outcome");

-- CreateIndex
CREATE INDEX "surge_zones_active_idx" ON "dispatch"."surge_zones"("active");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "dispatch"."outbox_events"("published_at", "created_at");

