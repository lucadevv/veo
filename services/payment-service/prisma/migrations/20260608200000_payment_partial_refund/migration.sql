-- F4 · Reembolsos PARCIALES (BR-P06).
-- Nuevo estado PARTIALLY_REFUNDED: un reembolso parcial al pasajero deja el cobro acá (sigue contando
-- para el payout del conductor — la plataforma absorbe el reembolso); al completar el monto pasa a REFUNDED.
-- `refunded_cents` acumula lo devuelto: valida el saldo reembolsable y sirve de CAS para refunds concurrentes.

-- AlterEnum: nuevo valor (no se USA en esta misma migración → válido dentro de la transacción en PG 12+).
ALTER TYPE "payment"."PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable: acumulador de reembolsos.
ALTER TABLE "payment"."payments" ADD COLUMN "refunded_cents" INTEGER NOT NULL DEFAULT 0;
