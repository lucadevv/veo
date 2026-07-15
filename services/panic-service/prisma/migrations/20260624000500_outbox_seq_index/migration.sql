-- CREATE del índice de la claim query CON seq SIN bloquear los INSERT de negocio (outbox_events es una tabla
-- VIVA). Mismo motivo y misma regla Prisma que el DROP (20260624000400): UN ÚNICO statement → Prisma NO lo
-- envuelve en tx → CONCURRENTLY es legal. El índice (published_at, failed_at, claimed_at, created_at, seq)
-- sirve el CLAIM: filtra pendientes (published_at IS NULL + failed_at IS NULL = no poison), descarta claim
-- vigente, y ordena por (created_at, seq) → el límite del batch y el orden de publicación son DETERMINISTAS.
-- Nombre FIJO `outbox_events_claim_idx` (vía @@index(map:) en schema.prisma) → corto, estable, cero drift con
-- el truncado de 63 chars que Prisma aplicaría a un nombre autogenerado de 6 columnas.
-- IF NOT EXISTS: idempotente si un build CONCURRENTLY previo falló y dejó un índice INVALID re-ejecutable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_events_claim_idx" ON "panic"."outbox_events"("published_at", "failed_at", "claimed_at", "created_at", "seq");
