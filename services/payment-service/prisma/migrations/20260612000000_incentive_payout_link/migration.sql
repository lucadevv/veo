-- Fix · el bono de incentivo del conductor nunca llegaba a un Payout (incentive.completed era huérfano):
-- `reward_granted_cents` se escribía pero `collectEarnings` solo sumaba payments CAPTURED + penalidades,
-- así que el bono jamás entraba a la liquidación. Estas columnas LIGAN el bono pagado a SU payout y
-- garantizan que se pague UNA sola vez (guard `paid_at IS NULL`, idempotencia financiera §3 CLAUDE).
--   - `paid_at`           : cuándo se liquidó el bono (NULL = pendiente de pago). Es el guard de idempotencia.
--   - `paid_in_payout_id` : a QUÉ Payout entró (trazabilidad contable; no es FK para no acoplar el borrado).
-- El índice (driver_id, paid_at) resuelve "bonos pendientes de un conductor" sin escanear la tabla, y
-- soporta el back-pay por ARRASTRE (el primer run post-deploy barre todos los `paid_at IS NULL` históricos).

ALTER TABLE "payment"."incentive_progress" ADD COLUMN "paid_at" TIMESTAMPTZ;
ALTER TABLE "payment"."incentive_progress" ADD COLUMN "paid_in_payout_id" UUID;

-- "bonos pendientes (paid_at IS NULL) de un conductor" en O(log n) para collectEarnings/back-pay.
CREATE INDEX "incentive_progress_driver_id_paid_at_idx" ON "payment"."incentive_progress"("driver_id", "paid_at");
