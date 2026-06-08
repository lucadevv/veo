-- PagoEfectivo (ProntoPaga · Ola pagos PE): el pasajero puede elegir PAGOEFECTIVO como método de pago
-- al crear el viaje. El valor ya existe en PaymentMethod de @veo/shared-types y en el enum de
-- payment-service; faltaba en el enum de trip-service, por lo que persistir un trip con este método
-- fallaba en runtime (el DTO validaba contra el enum compartido, pero Prisma rechazaba el valor).
-- Cobro real (CIP + webhook) lo gestiona payment-service; trip solo guarda el método elegido.

-- AlterEnum
ALTER TYPE "trip"."PaymentMethod" ADD VALUE 'PAGOEFECTIVO';
