-- PUJA (ADR 010 §3.1, decisión #4) · estado REASSIGNING: el conductor canceló DESPUÉS de aceptar
-- (pre-recojo) y el viaje re-abre la puja en vez de quedar abandonado (cierra el catastrófico #4).
-- NO terminal: REASSIGNING → ASSIGNED (re-match) | EXPIRED (sin ofertas) | CANCELLED_BY_PASSENGER.
-- Ver trip-service/prisma/schema.prisma.

-- AlterEnum
ALTER TYPE "trip"."TripStatus" ADD VALUE 'REASSIGNING';
