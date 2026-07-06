-- Índices faltantes del gate auditar-core (finanzas): polls/crons y hot-paths que hacían seq-scan o no
-- empujaban el rango temporal al índice. IF NOT EXISTS por idempotencia del deploy.

-- Payment · earningsForDriver empuja el RANGO captured_at (el antiguo [driver_id,status] no lo hacía). El 3-col
-- subsume al 2-col (mismo prefijo) → se reemplaza, no se duplica.
DROP INDEX IF EXISTS "payment"."payments_driver_id_status_idx";
CREATE INDEX IF NOT EXISTS "payments_driver_id_status_captured_at_idx"
  ON "payment"."payments" ("driver_id", "status", "captured_at");
-- Payment · polls por antigüedad (payment-poll + sweeps de reconciliación): status + created_at.
CREATE INDEX IF NOT EXISTS "payments_status_created_at_idx"
  ON "payment"."payments" ("status", "created_at");
-- Payment · fallback del webhook de cobro sin paymentId: correlaciona por external_uid (findFirst).
CREATE INDEX IF NOT EXISTS "payments_external_uid_idx"
  ON "payment"."payments" ("external_uid");

-- Payout · payout-poll (status=PROCESSING ordenado por updated_at, crash-recovery/reconciliación).
CREATE INDEX IF NOT EXISTS "payouts_status_updated_at_idx"
  ON "payment"."payouts" ("status", "updated_at");

-- IncentiveProgress · confirmación de desembolso (updateMany where paid_in_payout_id) + back-pay por arrastre
-- (escaneo de bonos PENDIENTES paid_at:null + completed_at en ventana, sin driver_id).
CREATE INDEX IF NOT EXISTS "incentive_progress_paid_in_payout_id_idx"
  ON "payment"."incentive_progress" ("paid_in_payout_id");
CREATE INDEX IF NOT EXISTS "incentive_progress_paid_at_completed_at_idx"
  ON "payment"."incentive_progress" ("paid_at", "completed_at");

-- CancellationPenalty · cron semanal de payouts (collectEarnings: status=COLLECTED + rango collected_at).
CREATE INDEX IF NOT EXISTS "cancellation_penalties_status_collected_at_idx"
  ON "payment"."cancellation_penalties" ("status", "collected_at");

-- Refund · barrido horario de refunds PENDING viejos (sweepStalePendingRefunds: status=PENDING + created_at).
CREATE INDEX IF NOT EXISTS "refunds_status_created_at_idx"
  ON "payment"."refunds" ("status", "created_at");
