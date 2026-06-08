-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payment";

-- CreateEnum
CREATE TYPE "payment"."PaymentMethod" AS ENUM ('YAPE', 'PLIN', 'CASH', 'CARD');

-- CreateEnum
CREATE TYPE "payment"."PaymentStatus" AS ENUM ('PENDING', 'CAPTURED', 'FAILED', 'REFUNDED', 'DEBT');

-- CreateEnum
CREATE TYPE "payment"."PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'HELD', 'FAILED');

-- CreateEnum
CREATE TYPE "payment"."RefundStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "payment"."payments" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "driver_id" UUID,
    "dedup_key" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "gross_cents" INTEGER NOT NULL,
    "tip_cents" INTEGER NOT NULL DEFAULT 0,
    "commission_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "method" "payment"."PaymentMethod" NOT NULL,
    "external_ref" TEXT,
    "status" "payment"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "payer_ref" TEXT,
    "captured_at" TIMESTAMPTZ,
    "refunded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."payouts" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "gross_cents" INTEGER NOT NULL,
    "commission_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "status" "payment"."PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "processed_at" TIMESTAMPTZ,
    "held_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "status" "payment"."RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."cash_confirmations" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "driver_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "passenger_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cash_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."reconciliation_runs" (
    "id" UUID NOT NULL,
    "ran_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discrepancy_pct" DOUBLE PRECISION NOT NULL,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_dedup_key_key" ON "payment"."payments"("dedup_key");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payment"."payments"("status");

-- CreateIndex
CREATE INDEX "payments_trip_id_idx" ON "payment"."payments"("trip_id");

-- CreateIndex
CREATE INDEX "payments_driver_id_status_idx" ON "payment"."payments"("driver_id", "status");

-- CreateIndex
CREATE INDEX "payments_method_status_captured_at_idx" ON "payment"."payments"("method", "status", "captured_at");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payment"."payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_driver_id_period_start_period_end_key" ON "payment"."payouts"("driver_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "payment"."refunds"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "payment"."refunds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_confirmations_trip_id_key" ON "payment"."cash_confirmations"("trip_id");

-- CreateIndex
CREATE INDEX "reconciliation_runs_ran_at_idx" ON "payment"."reconciliation_runs"("ran_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "payment"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "payment"."refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"."payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

