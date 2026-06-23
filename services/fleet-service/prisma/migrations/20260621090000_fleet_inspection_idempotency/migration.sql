-- IDEMPOTENCIA de la inspección técnica (ITV · FOUNDATION §0.4). Un re-POST (doble click / retry de red)
-- creaba filas duplicadas: ensuciaban la traza de compliance aunque el gate (orderBy inspectedAt desc)
-- tomara la última. El natural key [vehicle_id, inspected_at, inspector_id] colapsa el duplicado EXACTO a
-- una sola fila; el service maneja el P2002 con una respuesta idempotente (devuelve la fila ya escrita).
-- Dos inspecciones REALES distintas del mismo vehículo difieren en `inspected_at` → NO colisionan.
--
-- El prefijo [vehicle_id, inspected_at] del UNIQUE sirve además el `orderBy inspected_at desc` del gate, por
-- lo que el índice standalone previo `inspections_vehicle_id_inspected_at_idx` queda redundante y se elimina.
-- Ver fleet-service/prisma/schema.prisma (model Inspection).

-- DropIndex (redundante: lo cubre el prefijo del UNIQUE de abajo)
DROP INDEX IF EXISTS "fleet"."inspections_vehicle_id_inspected_at_idx";

-- CreateIndex (UNIQUE natural key)
CREATE UNIQUE INDEX "inspections_vehicle_id_inspected_at_inspector_id_key" ON "fleet"."inspections"("vehicle_id", "inspected_at", "inspector_id");
