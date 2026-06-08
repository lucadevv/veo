-- Persistir el pasajero del viaje en el cobro para enriquecer payment.captured / payment.refunded
-- (push al pasajero "pago confirmado" / "te devolvimos") sin un join cross-servicio. Opcional.

-- AlterTable: passenger_id en payments (lo trae el trip.completed que dispara el cobro).
ALTER TABLE "payment"."payments"
  ADD COLUMN "passenger_id" UUID;
