-- F1 FIX 3: índice que respalda GET /published-trips/mine.
-- La query es: WHERE driver_id = ? ORDER BY id DESC (keyset por id uuidv7 time-ordered, FIX 2).
-- El índice solo (driver_id) scopeaba pero NO respaldaba el ORDER BY → Postgres ordenaba en memoria por
-- conductor. El compuesto (driver_id, id) deja que el planner haga scope + orden por índice (sin sort).
-- (driver_id) queda cubierto como PREFIJO del compuesto, así que se dropea el índice simple (redundante).

-- DropIndex
DROP INDEX "booking"."published_trips_driver_id_idx";

-- CreateIndex
CREATE INDEX "published_trips_driver_id_id_idx" ON "booking"."published_trips"("driver_id", "id");
