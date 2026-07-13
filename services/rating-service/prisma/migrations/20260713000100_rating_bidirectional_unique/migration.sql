-- Calificación BIDIRECCIONAL: el conductor y el pasajero pueden calificar el MISMO viaje (cada uno a su
-- contraparte). El UNIQUE(trip_id) sólo permitía UNA calificación por viaje (el que calificaba primero
-- ganaba; el otro recibía 409 "Ya existe una calificación") → se reemplaza por UNIQUE(trip_id, rater_id):
-- una por viaje POR rater.
--
-- Seguro SIN backfill: hoy cada viaje tiene ≤1 calificación (por el unique viejo), así que
-- (trip_id, rater_id) ya es único para todas las filas existentes → el índice compuesto no puede fallar.
DROP INDEX "rating"."ratings_trip_id_key";
CREATE UNIQUE INDEX "ratings_trip_id_rater_id_key" ON "rating"."ratings"("trip_id", "rater_id");
