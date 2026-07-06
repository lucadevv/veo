-- Credit-back (gate auditar-core · MEDIA #4) · Ledger de CRÉDITOS a favor del conductor: el INVERSO de
-- driver_debts. Hoy solo lo origina el reverso de una comisión CASH cuya deuda YA se neteó en un payout
-- (SETTLED): al revertir el viaje, el conductor pagó una comisión que ya no debía → se le acredita y se SUMA al
-- neto del próximo payout (applyDebtNetting). Tabla separada (no un debt con monto negativo) → preserva el
-- contrato driver_debts.payment_id UNIQUE y una responsabilidad por tabla. Idempotente por source_payment_id.
CREATE TYPE "payment"."DriverCreditStatus" AS ENUM ('PENDING', 'APPLIED');

CREATE TABLE "payment"."driver_credits" (
  "id"                   UUID NOT NULL,
  "driver_id"            UUID NOT NULL,
  "trip_id"              UUID NOT NULL,
  "amount_cents"         INTEGER NOT NULL,
  "currency"             TEXT NOT NULL DEFAULT 'PEN',
  "source_payment_id"    UUID NOT NULL,
  "status"               "payment"."DriverCreditStatus" NOT NULL DEFAULT 'PENDING',
  "applied_in_payout_id" UUID,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at"           TIMESTAMPTZ,
  CONSTRAINT "driver_credits_pkey" PRIMARY KEY ("id")
);

-- Idempotencia: un crédito por reverso de cobro CASH (un refund re-entregado no duplica el crédito).
CREATE UNIQUE INDEX "driver_credits_source_payment_id_key" ON "payment"."driver_credits"("source_payment_id");
-- Netting: enumerar el crédito PENDIENTE de un conductor en el run de payouts.
CREATE INDEX "driver_credits_driver_id_status_idx" ON "payment"."driver_credits"("driver_id", "status");
