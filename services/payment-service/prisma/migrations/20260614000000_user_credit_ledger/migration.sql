-- Redención de crédito de referidos (Ola 2A · Lote A). El crédito ganado (referral.rewarded) no tenía
-- destino gastable: identity acumulaba `User.referral_reward_cents` (display) pero el cobro nunca lo
-- aplicaba (gap auditado 2026-06). payment-service pasa a ser dueño del saldo GASTABLE: el consumer de
-- `referral.rewarded` acredita acá, y el cobro del viaje lo descuenta + DECREMENTA en la misma tx ACID
-- (Lote B) — sin doble-gasto cross-service.
--   - `user_credits`        : saldo vivo por usuario (balance_cents, nunca negativo).
--   - `user_credit_entries` : ledger append-only de movimientos. `source_ref` UNIQUE = idempotencia
--                             financiera (§3 CLAUDE): un `referral.rewarded` re-entregado no re-acredita.

-- CreateEnum
CREATE TYPE "payment"."CreditSource" AS ENUM ('REFERRAL');

-- CreateTable
CREATE TABLE "payment"."user_credits" (
    "user_id" UUID NOT NULL,
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_credits_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "payment"."user_credit_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delta_cents" INTEGER NOT NULL,
    "source" "payment"."CreditSource" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_credit_entries_source_ref_key" ON "payment"."user_credit_entries"("source_ref");

-- CreateIndex
CREATE INDEX "user_credit_entries_user_id_idx" ON "payment"."user_credit_entries"("user_id");

-- AddForeignKey
ALTER TABLE "payment"."user_credit_entries" ADD CONSTRAINT "user_credit_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "payment"."user_credits"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
