-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notification";

-- CreateEnum
CREATE TYPE "notification"."NotificationChannel" AS ENUM ('PUSH', 'SMS', 'EMAIL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "notification"."NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "notification"."notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" TEXT NOT NULL,
    "channel" "notification"."NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "notification"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "dedup_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "failed_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification"."templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "channel" "notification"."NotificationChannel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es-PE',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notification"."notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notification"."notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notification"."notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "templates_key_key" ON "notification"."templates"("key");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "notification"."outbox_events"("published_at", "created_at");

