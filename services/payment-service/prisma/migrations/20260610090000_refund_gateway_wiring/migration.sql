-- S5 · Reembolso REAL contra el proveedor (BR-P06).
-- El Refund digital nace PENDING (intent persistido ANTES de llamar al riel, idempotencia §4) y SOLO
-- pasa a COMPLETED cuando el proveedor confirma el reverso (síncrono o por callback urlCallbackRefund).
-- `external_refund_id` correlaciona el callback asíncrono de ProntoPaga (uid del reverso).
-- `failure_reason` registra el motivo del RECHAZO del proveedor (distinto de `reason`, motivo del pedido).

ALTER TABLE "payment"."refunds" ADD COLUMN "external_refund_id" TEXT;
ALTER TABLE "payment"."refunds" ADD COLUMN "failure_reason" TEXT;

-- Correlación del callback de reembolso del proveedor (uid → Refund).
CREATE INDEX "refunds_external_refund_id_idx" ON "payment"."refunds"("external_refund_id");
