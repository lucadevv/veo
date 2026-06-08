-- Categoría/opción de tarifa elegida por el pasajero en la cotización (quoteOption.id).
-- Solo persiste la elección; la tarifa firme (fare_cents) no se recalcula por categoría (BR-T05).
ALTER TABLE "trip"."trips" ADD COLUMN "category" TEXT;
