-- #24 — Índice compuesto para la cola de aprobación del operador (`listPendingApproval`): filtra por
-- background_check_status=PENDING y ordena por created_at asc. Sin esto, la consulta era un seq scan + sort
-- sobre `identity.drivers` (que crece sin techo). El índice compuesto sirve el WHERE y el ORDER BY de una sola.
-- CreateIndex
CREATE INDEX "drivers_background_check_status_created_at_idx" ON "identity"."drivers"("background_check_status", "created_at");
