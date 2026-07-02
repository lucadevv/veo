-- A1 (ADR-022) · CLASE del cobro: FARE (tarifa, default) | TIP (propina DIGITAL dedicada). Discriminador
-- TIPADO (no inferir por gross=0): separa el cobro de propina del cobro de tarifa para que los lookups by-trip
-- de la TARIFA (refund, recibo) NO agarren un cobro de propina. La propina en EFECTIVO no crea Payment (va como
-- TipAddition "en mano"); solo la digital es un Payment kind=TIP. NOT NULL DEFAULT 'FARE' → toda fila existente
-- queda FARE, cero cambio de comportamiento al desplegar.
CREATE TYPE "payment"."PaymentKind" AS ENUM ('FARE', 'TIP');

ALTER TABLE "payment"."payments"
  ADD COLUMN "kind" "payment"."PaymentKind" NOT NULL DEFAULT 'FARE';
