-- Redención de crédito de referido en el cobro (Ola 2A · Lote B). El crédito ganado (Lote A) ahora se
-- APLICA al cobro del viaje como descuento al pasajero (mismo trato que la promo: la plataforma lo absorbe,
-- comisión sobre el bruto, conductor intacto), decrementando el saldo en la misma operación idempotente.
--   - CreditSource.TRIP_REDEMPTION : el movimiento de GASTO del ledger (delta < 0).
--   - payments.credit_cents        : crédito gastado en ESTE cobro, separado de discount_cents (promo) para
--                                    reconciliación (Ley 29733: promo = campaña, crédito = saldo del usuario).

-- AlterEnum
ALTER TYPE "payment"."CreditSource" ADD VALUE 'TRIP_REDEMPTION';

-- AlterTable
ALTER TABLE "payment"."payments" ADD COLUMN "credit_cents" INTEGER NOT NULL DEFAULT 0;
