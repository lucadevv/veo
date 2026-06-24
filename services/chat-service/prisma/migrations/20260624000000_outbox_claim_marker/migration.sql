-- Outbox CLAIM-MARKER + POISON-TERMINAL (desacople I/O ↔ tx + poison-pill fix, @veo/database PrismaOutboxStore).
-- SOLO columnas acá (ADD COLUMN nullable = rápido, NO reescribe la tabla en PG moderno → no bloquea INSERTs).
-- Los índices van en migraciones SEPARADAS con CONCURRENTLY (no pueden correr en una tx; ver las migraciones
-- 20260624000100 y 20260624000200). 'claimed_at' marca una fila reclamada por un relay ANTES de publicar;
-- 'failed_at' marca un evento POISON terminal (payload inválido) que el claim EXCLUYE (no reintenta, no bloquea
-- el grupo per-aggregate). Ambas aditivas y nullable: las filas existentes quedan en NULL.
ALTER TABLE "chat"."outbox_events" ADD COLUMN "claimed_at" TIMESTAMPTZ;
ALTER TABLE "chat"."outbox_events" ADD COLUMN "failed_at" TIMESTAMPTZ;
