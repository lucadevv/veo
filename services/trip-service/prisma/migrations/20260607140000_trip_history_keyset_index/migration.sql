-- Historial del pasajero (hot-path) · paginación keyset por (requested_at, id) DESC.
-- ListPassengerTrips devuelve SUS viajes ordenados por requested_at DESC con tie-break por id DESC
-- (cursor estable: a escala el offset degrada y se desincroniza si entran viajes nuevos; el keyset no).
-- Reemplaza el índice previo [passenger_id, requested_at] (prefijo, lo subsume) por uno que INCLUYE id,
-- para que el comparador (requested_at, id) < (cursorReqAt, cursorId) quede 100% cubierto por el índice
-- (sin sort ni filtro residual). Postgres escanea el btree HACIA ATRÁS para el ORDER BY ... DESC, así
-- que el índice ascendente sirve a ambos sentidos. Ver trip-service/prisma/schema.prisma model Trip.

-- DropIndex (el viejo índice de 2 columnas queda subsumido por el de 3)
DROP INDEX "trip"."trips_passenger_id_requested_at_idx";

-- CreateIndex
CREATE INDEX "trips_passenger_id_requested_at_id_idx" ON "trip"."trips"("passenger_id", "requested_at", "id");
