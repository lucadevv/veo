-- A2 (ADR-022 §P-A) · Ledger de DEUDAS del conductor con la plataforma. Nace cuando el conductor cobra la
-- comisión EN MANO (viaje CASH): la plataforma no la recaudó → el conductor la debe, y se NETEA contra su payout
-- digital. Es el flujo INVERSO del dinero, modelado explícito. Idempotente por payment_id (una deuda por cobro).
CREATE TYPE "payment"."DriverDebtReason" AS ENUM ('CASH_COMMISSION');
CREATE TYPE "payment"."DriverDebtStatus" AS ENUM ('PENDING', 'SETTLED', 'REVERSED');

CREATE TABLE "payment"."driver_debts" (
  "id"                   UUID NOT NULL,
  "driver_id"            UUID NOT NULL,
  "trip_id"              UUID NOT NULL,
  "payment_id"           UUID NOT NULL,
  "amount_cents"         INTEGER NOT NULL,
  "currency"             TEXT NOT NULL DEFAULT 'PEN',
  "reason"               "payment"."DriverDebtReason" NOT NULL DEFAULT 'CASH_COMMISSION',
  "status"               "payment"."DriverDebtStatus" NOT NULL DEFAULT 'PENDING',
  "settled_in_payout_id" UUID,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at"           TIMESTAMPTZ,
  CONSTRAINT "driver_debts_pkey" PRIMARY KEY ("id")
);

-- Idempotencia: una deuda por cobro CASH (la captura no la duplica aunque se reintente).
CREATE UNIQUE INDEX "driver_debts_payment_id_key" ON "payment"."driver_debts"("payment_id");
-- Netting: enumerar la deuda PENDIENTE de un conductor en el run de payouts.
CREATE INDEX "driver_debts_driver_id_status_idx" ON "payment"."driver_debts"("driver_id", "status");

-- A2 · auditoría del neteo: cuánta deuda CASH se descontó en cada payout (0 si no había deuda). NOT NULL
-- DEFAULT 0 → los payouts existentes quedan con 0, cero cambio de comportamiento al desplegar.
ALTER TABLE "payment"."payouts" ADD COLUMN "debt_applied_cents" INTEGER NOT NULL DEFAULT 0;
