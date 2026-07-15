-- F3b FIX 5: índice que respalda GET /published-trips/:id/bookings (listRequestsForTrip).
-- La query es: WHERE published_trip_id = ? ORDER BY id DESC (keyset por id uuidv7 time-ordered).
-- El índice (published_trip_id, estado) scopeaba por viaje pero NO respaldaba el ORDER BY id (la 2da columna
-- es estado, no id) → Postgres ordenaba en memoria por viaje. El compuesto (published_trip_id, id) deja que el
-- planner haga scope + orden por índice (sin sort). Espeja (driver_id, id) de published_trips (GET /mine).
-- El índice (published_trip_id, estado) se MANTIENE (respalda los filtros por estado); este se AÑADE.

-- CreateIndex
CREATE INDEX "bookings_published_trip_id_id_idx" ON "booking"."bookings"("published_trip_id", "id");
