-- dispatch_matches.sweepExpiredOffers (matching.service.ts) corre ~0.5Hz desde el reconciler (@Interval):
-- filtra `outcome = OFFERED` (igualdad) + `offered_at < cutoff` (rango) y ordena por offered_at asc. Los
-- índices previos arrancan por trip_id → inusables para este filtro. dispatch_matches es append-forever
-- (solo crece) → sin este índice era un seq scan recurrente sobre tabla creciente. Orden de columnas:
-- outcome primero (igualdad), offered_at segundo (rango + orden) — patrón estándar de índice compuesto.

-- CreateIndex
CREATE INDEX "dispatch_matches_outcome_offered_at_idx" ON "dispatch"."dispatch_matches"("outcome", "offered_at");
