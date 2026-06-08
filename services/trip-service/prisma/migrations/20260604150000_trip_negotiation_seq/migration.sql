-- H13 · negotiation_seq: sello MONOTÓNICO del ciclo de negociación de la PUJA.
-- A DIFERENCIA de reassign_count (que rebid resetea a 0), este contador NUNCA decrece: se incrementa
-- cada vez que la negociación ABRE o RE-ABRE (createTrip-puja=1, rebid=+1, reassignAfterDriverCancel=+1).
-- Viaja en trip.bid_posted / trip.reassigning; dispatch lo estampa en dispatch.offer_accepted, y
-- applyAgreedFare lo exige en el `where` atómico. Cierra el residual money-path (LOW): una redelivery
-- Kafka STALE de un offer_accepted de un ciclo VIEJO (seq menor) NO matchea la fila vigente → no-op,
-- y no escribe la tarifa rancia del conductor del ciclo anterior. Viajes legacy sin puja quedan en 0.
-- Ver schema.prisma model Trip.

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "negotiation_seq" INTEGER NOT NULL DEFAULT 0;
