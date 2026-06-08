-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "rating";

-- CreateEnum
CREATE TYPE "rating"."SubjectRole" AS ENUM ('DRIVER', 'PASSENGER');

-- CreateTable
CREATE TABLE "rating"."ratings" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "rater_id" UUID NOT NULL,
    "rated_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating"."rating_aggregates" (
    "subject_id" UUID NOT NULL,
    "role" "rating"."SubjectRole" NOT NULL,
    "rolling_avg_30d" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "count_30d" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "last_computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_aggregates_pkey" PRIMARY KEY ("subject_id")
);

-- CreateTable
CREATE TABLE "rating"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ratings_trip_id_key" ON "rating"."ratings"("trip_id");

-- CreateIndex
CREATE INDEX "ratings_rated_id_created_at_idx" ON "rating"."ratings"("rated_id", "created_at");

-- CreateIndex
CREATE INDEX "rating_aggregates_role_flagged_idx" ON "rating"."rating_aggregates"("role", "flagged");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "rating"."outbox_events"("published_at", "created_at");

-- CHECK: estrellas en rango 1..5 (BR-D01/BR-I05; Prisma no modela CHECK, se añade manual)
ALTER TABLE "rating"."ratings" ADD CONSTRAINT "ratings_stars_range_check" CHECK ("stars" >= 1 AND "stars" <= 5);

