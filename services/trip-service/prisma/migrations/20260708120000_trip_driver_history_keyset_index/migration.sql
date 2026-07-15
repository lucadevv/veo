-- Historial del CONDUCTOR (hot-path) · paginación keyset por (requested_at, id) DESC. ESPEJO del índice
-- del pasajero (trips_passenger_id_requested_at_id_idx): ListDriverTrips devuelve SUS viajes ordenados
-- por requested_at DESC con tie-break por id DESC (cursor estable; a escala el offset degrada). Incluir
-- `id` deja el comparador (requested_at, id) < (cursorReqAt, cursorId) 100% cubierto por el índice (sin
-- sort ni filtro residual). Postgres escanea el btree HACIA ATRÁS para el ORDER BY ... DESC, así que el
-- índice ascendente sirve a ambos sentidos. El índice existente [driver_id, status] sirve a
-- GetActiveTripByDriver (filtra por estado vivo), NO cubre el orden del historial. Ver schema.prisma.

-- CreateIndex
CREATE INDEX "trips_driver_id_requested_at_id_idx" ON "trip"."trips"("driver_id", "requested_at", "id");
