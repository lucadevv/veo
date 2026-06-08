-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "panic";

-- CreateEnum
CREATE TYPE "panic"."PanicStatus" AS ENUM ('TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM');

-- CreateTable
CREATE TABLE "panic"."panic_events" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "triggered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geo_lat" DOUBLE PRECISION NOT NULL,
    "geo_lon" DOUBLE PRECISION NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "status" "panic"."PanicStatus" NOT NULL DEFAULT 'TRIGGERED',
    "evidence_s3_keys" TEXT[],
    "acknowledged_at" TIMESTAMPTZ,
    "ack_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panic_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panic"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "panic_events_dedup_key_key" ON "panic"."panic_events"("dedup_key");

-- CreateIndex
CREATE INDEX "panic_events_status_triggered_at_idx" ON "panic"."panic_events"("status", "triggered_at");

-- CreateIndex
CREATE INDEX "panic_events_trip_id_idx" ON "panic"."panic_events"("trip_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "panic"."outbox_events"("published_at", "created_at");

