-- ADR-015 (sub-lote 2a · FUNDACIÓN money-OUT) · idempotencia + ref del riel del DESEMBOLSO.
-- Aditivo y de bajo riesgo: agrega DOS columnas nullable a `payment.payouts` SIN tocar el comportamiento
-- del cron de payout (el refactor del ciclo PROCESSING/FAILED es el sub-lote 2b).
--
--   · dedup_key  → idempotencia financiera del disburse (ADR-015 §7): `payout-disburse:{payoutId}`.
--                  UNIQUE (espeja `refunds.dedup_key`): reintentos del mismo payout NO duplican la
--                  transferencia. Nullable: los payouts existentes (pre-desembolso-real) quedan en NULL.
--   · external_ref → uid de la transferencia en el riel (PayoutGateway). Correlaciona el webhook/poll de
--                    confirmación (PROCESSING→PROCESSED|FAILED). Null hasta que el operador dispara el payout.

ALTER TABLE "payment"."payouts" ADD COLUMN "dedup_key" TEXT;
ALTER TABLE "payment"."payouts" ADD COLUMN "external_ref" TEXT;

-- UNIQUE de la idempotencia del disburse. Prisma lo modela con `@unique` en el campo (genera un índice
-- único estándar sobre la columna nullable: Postgres permite múltiples NULL, así que los payouts pre-disburse
-- conviven sin chocar; recién al disparar el desembolso se setea la key única).
CREATE UNIQUE INDEX "payouts_dedup_key_key" ON "payment"."payouts" ("dedup_key");
