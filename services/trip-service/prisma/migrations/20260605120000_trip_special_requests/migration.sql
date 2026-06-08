-- BE-2 · special_requests: solicitudes especiales del pasajero al conductor (mascota/equipaje/silla).
-- El conductor las VE antes de aceptar la puja: viajan en trip.bid_posted → dispatch las guarda en el
-- board → la vista de puja del conductor las muestra. "Parada" NO va acá (es un waypoint del trayecto).
-- Array de enum, default {} (ninguna) para que las filas LEGACY queden sin solicitudes.
-- Ver trip-service/prisma/schema.prisma model Trip + enum SpecialRequest.

-- CreateEnum
CREATE TYPE "trip"."SpecialRequest" AS ENUM ('PET', 'LUGGAGE', 'CHILD_SEAT');

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "special_requests" "trip"."SpecialRequest"[] NOT NULL DEFAULT ARRAY[]::"trip"."SpecialRequest"[];
