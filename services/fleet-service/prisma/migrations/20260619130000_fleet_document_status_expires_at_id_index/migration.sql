-- Cubre el orderBy compuesto de listExpirations `(expires_at, id)` con `status IN (...)`: el `id` final
-- evita el Sort del keyset (perf). Por leftmost-prefix el índice de 3 columnas también cubre los queries
-- que filtraban solo (status, expires_at), así que el de 2 columnas queda redundante y se reemplaza.
-- Aditivo y seguro. IF [NOT] EXISTS = idempotente.
DROP INDEX IF EXISTS "fleet"."fleet_documents_status_expires_at_idx";

CREATE INDEX IF NOT EXISTS "fleet_documents_status_expires_at_id_idx" ON "fleet"."fleet_documents"("status", "expires_at", "id");
