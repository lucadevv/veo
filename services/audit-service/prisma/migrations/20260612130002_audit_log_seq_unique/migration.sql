-- audit_log.seq es la fuente de verdad del orden de la cadena (BigInt autoincrement, monotónico único).
-- El append (AuditRepository.appendEntry) hace `orderBy seq desc` en CADA inserción DENTRO del advisory
-- lock global (pg_advisory_xact_lock 4951) que serializa todos los writers → sin índice era un scan O(n)
-- creciente en la sección crítica. query()/getRange() también filtran/ordenan por seq. @unique además
-- documenta la invariante de unicidad (no hay duplicados posibles: lo asigna Postgres por autoincrement).

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit"."audit_log"("seq");
