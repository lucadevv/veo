-- DEBT gate: índice para listar la deuda PENDIENTE de un pasajero sin escanear toda la tabla.
-- GET /payments/debt resuelve por (passenger_id, status='DEBT') → bloqueo de nuevos viajes (BR-P02).
-- El índice cubre la query del gate (puntual por pasajero) en O(log n).
CREATE INDEX "payments_passenger_id_status_idx"
  ON "payment"."payments" ("passenger_id", "status");
