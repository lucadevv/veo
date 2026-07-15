-- ADR-022 §P-A · TOPE de deuda CASH del conductor + LIQUIDACIÓN por el rail.
-- Al cruzar `DRIVER_DEBT_CAP_CENTS` el conductor queda BLOQUEADO (hold DEBT_BLOCKED en identity, gate ya existente);
-- salda su deuda con un cobro DIGITAL kind=DEBT_SETTLEMENT (Yape/Plin/Card vía ProntoPaga) → al capturar, sus
-- driver_debts PENDING pasan a PAID y se emite `driver.debt_cleared` (desbloqueo).

-- 1) Nuevo kind de Payment: la liquidación de deuda del conductor (NO es tarifa ni propina).
ALTER TYPE "payment"."PaymentKind" ADD VALUE 'DEBT_SETTLEMENT';

-- 2) Nuevo estado de deuda: PAID = saldada directamente por el conductor (distinto de SETTLED = neteada de un payout).
--    El netting del payout SOLO mira PENDING → una deuda PAID queda fuera del neteo (cero doble cobro).
ALTER TYPE "payment"."DriverDebtStatus" ADD VALUE 'PAID';

-- 3) Payment: a QUIÉN desbloquear al capturar una liquidación (driver_id de la fila va NULL para no entrar al payout).
ALTER TABLE "payment"."payments" ADD COLUMN "debt_settlement_driver_id" UUID;

-- 4) DriverDebt: el Payment de liquidación que la saldó (status=PAID). Null salvo PAID. Conciliación/auditoría.
ALTER TABLE "payment"."driver_debts" ADD COLUMN "settled_payment_id" UUID;
