-- F2.3 · Saldar una penalidad de cancelación "como un DEBT" (por el rail).
-- Un Payment de LIQUIDACIÓN salda una penalidad: lleva `cancellation_penalty_id` (la penalidad que
-- salda) y `driver_id` NULL (no es ganancia de viaje → no entra al payout por esta fila; la
-- compensación del conductor entra vía collectEarnings sumando la penalidad COLLECTED). Al capturarse,
-- captureSuccess flippea la penalidad → COLLECTED en la misma transacción.

-- AddColumn
ALTER TABLE "payment"."payments" ADD COLUMN "cancellation_penalty_id" UUID;

-- CreateIndex (resolver el Payment de liquidación de una penalidad · idempotencia/conciliación)
CREATE INDEX "payments_cancellation_penalty_id_idx" ON "payment"."payments"("cancellation_penalty_id");
