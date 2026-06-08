-- Ola 2A · Código de promoción del viaje (se propaga en trip.completed al cobro).
ALTER TABLE "trip"."trips" ADD COLUMN "promo_code" TEXT;
