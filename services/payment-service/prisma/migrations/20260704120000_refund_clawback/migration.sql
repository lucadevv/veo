-- RC18 (ADR-022) · Clawback CONDICIONAL del neto del conductor en un refund TOTAL de tarifa digital por causa
-- atribuible al conductor. Antes: un refund digital post-payout no recuperaba nada (el enum de deuda solo tenía
-- CASH_COMMISSION y refundViaGateway no tocaba DriverDebt) → la plataforma comía el neto ya pagado. Ahora, si el
-- operador marca el refund como driverFault, un refund TOTAL genera una DriverDebt REFUND_CLAWBACK que se netea del
-- próximo payout. Un dispute/fraude del PASAJERO (default) NO genera deuda (lo absorbe la plataforma).

-- Nuevo motivo de deuda del conductor. ADD VALUE es transaccional en Postgres 12+ (el valor no se USA en esta
-- misma migración, solo se agrega al tipo).
ALTER TYPE "payment"."DriverDebtReason" ADD VALUE 'REFUND_CLAWBACK';

-- Señal persistida de "causa atribuible al conductor" en el refund. NOT NULL DEFAULT false → los refunds
-- existentes quedan como "lo absorbe la plataforma" (sin clawback retroactivo), cero cambio al desplegar.
ALTER TABLE "payment"."refunds"
  ADD COLUMN "clawback_driver" BOOLEAN NOT NULL DEFAULT false;
