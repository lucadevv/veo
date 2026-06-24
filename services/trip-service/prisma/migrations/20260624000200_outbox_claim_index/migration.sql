-- CREATE del índice de la claim query SIN bloquear los INSERT de negocio. Mismo motivo y misma regla Prisma
-- que el DROP (20260624000100): UN ÚNICO statement → Prisma NO lo envuelve en tx → CONCURRENTLY es legal.
-- El índice (published_at, failed_at, claimed_at, created_at) sirve el CLAIM: filtra pendientes (published_at
-- IS NULL + failed_at IS NULL = no poison), descarta claim vigente, ordena por created_at.
-- IF NOT EXISTS: idempotente si un build CONCURRENTLY previo falló y dejó un índice INVALID re-ejecutable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_events_published_at_failed_at_claimed_at_created_at_idx" ON "trip"."outbox_events"("published_at", "failed_at", "claimed_at", "created_at");
