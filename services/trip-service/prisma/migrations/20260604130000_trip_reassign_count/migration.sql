-- PUJA robustez #4 · contador de re-asignaciones tras cancelación del conductor post-accept.
-- Cada cancelación del conductor (ACCEPTED/ARRIVING/ARRIVED) incrementa este contador. Superado el tope
-- (env TRIP_MAX_REASSIGN, default 3) el viaje NO se re-puja más: cae a FAILED y se notifica al pasajero
-- (callejón sin salida honesto, no un bucle infinito de cancelaciones). Ver schema.prisma model Trip.

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "reassign_count" INTEGER NOT NULL DEFAULT 0;
