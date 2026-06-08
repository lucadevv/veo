-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "chat";

-- CreateEnum
CREATE TYPE "chat"."SenderRole" AS ENUM ('PASSENGER', 'DRIVER');

-- CreateTable
CREATE TABLE "chat"."messages" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "sender_role" "chat"."SenderRole" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_trip_id_created_at_idx" ON "chat"."messages"("trip_id", "created_at");

