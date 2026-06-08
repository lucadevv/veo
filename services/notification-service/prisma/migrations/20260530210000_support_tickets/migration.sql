-- CreateEnum
CREATE TYPE "notification"."SupportRole" AS ENUM ('PASSENGER', 'DRIVER');

-- CreateEnum
CREATE TYPE "notification"."SupportCategory" AS ENUM ('TRIP', 'PAYMENT', 'ACCOUNT', 'SAFETY', 'DRIVER', 'OTHER');

-- CreateEnum
CREATE TYPE "notification"."SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateTable
CREATE TABLE "notification"."support_tickets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "notification"."SupportRole" NOT NULL,
    "category" "notification"."SupportCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "notification"."SupportStatus" NOT NULL DEFAULT 'OPEN',
    "trip_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_user_id_created_at_idx" ON "notification"."support_tickets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_created_at_idx" ON "notification"."support_tickets"("status", "created_at");

