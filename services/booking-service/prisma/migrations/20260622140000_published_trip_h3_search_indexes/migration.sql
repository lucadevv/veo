-- F2 BÚSQUEDA GEO: índices que respaldan GET /published-trips/search.
-- La query del pasajero filtra una RUTA A→B por celda índice H3:
--   WHERE origin_h3 IN (ring) AND dest_h3 IN (ring)
--     AND estado IN ('PUBLICADO','PARCIALMENTE_RESERVADO')
--     AND fecha_hora_salida BETWEEN <inicio_dia> AND <fin_dia> AND fecha_hora_salida > now()
--   ORDER BY fecha_hora_salida ASC
-- Sin estos índices la búsqueda geo es un FULL SCAN de published_trips por cada request (el gate
-- 'missing-index' lo marca). La columna LÍDER es el H3 (alta selectividad: la celda res-9 acota a ~174m),
-- seguida de estado (filtro) y fecha_hora_salida (filtro de rango + ORDER BY servido por el índice).
-- Las columnas origin_h3 / dest_h3 ya existen (nullable) desde la migración init; acá solo se indexan.

-- CreateIndex
CREATE INDEX "published_trips_origin_h3_estado_fecha_hora_salida_idx" ON "booking"."published_trips"("origin_h3", "estado", "fecha_hora_salida");

-- CreateIndex
CREATE INDEX "published_trips_dest_h3_estado_fecha_hora_salida_idx" ON "booking"."published_trips"("dest_h3", "estado", "fecha_hora_salida");
