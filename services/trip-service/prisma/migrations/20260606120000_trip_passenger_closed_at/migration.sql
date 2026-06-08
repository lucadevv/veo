-- Re-entrada del cierre post-viaje · passenger_closed_at: marca de cuándo el PASAJERO dio por cerrado
-- el post-viaje (recibo + confirmar efectivo + rating). COMPLETED SIGUE siendo terminal (BR-T02 no
-- cambia): este campo NO es un estado, es un flag de UX. El "pending settlement" del pasajero = su
-- viaje COMPLETED MÁS VIEJO con passenger_closed_at = NULL (orden FIFO, completed_at asc); cerrarlo lo
-- sella (idempotente) y deja de aparecer. Aditiva, nullable: las filas LEGACY quedan NULL (sin viaje cerrado).
-- Ver trip-service/prisma/schema.prisma model Trip.

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "passenger_closed_at" TIMESTAMPTZ;

-- CreateIndex
-- Cubre el filtro del pending settlement (passenger_id, status) y el orden FIFO (completed_at asc).
-- Candidato a índice PARCIAL `WHERE passenger_closed_at IS NULL` si el volumen lo pide (la cola de
-- pendientes es chica frente al histórico de COMPLETED); Prisma no modela índices parciales, habría que
-- agregarlo a mano en una migración SQL.
CREATE INDEX "trips_passenger_id_status_completed_at_idx" ON "trip"."trips"("passenger_id", "status", "completed_at");
