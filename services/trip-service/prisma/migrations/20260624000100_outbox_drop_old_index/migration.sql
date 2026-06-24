-- DROP del índice viejo SIN bloquear los INSERT de negocio (outbox_events es una tabla VIVA: cada tx de
-- dominio inserta vía enqueueOutbox). CONCURRENTLY toma un lock que NO bloquea escrituras. REGLA Prisma 5.x:
-- CONCURRENTLY no puede correr dentro de una transacción y Prisma envuelve una migración en tx SOLO si tiene
-- MÁS DE UN statement → este archivo lleva UN ÚNICO statement para que Prisma lo ejecute SIN tx.
-- (https://github.com/prisma/prisma/issues/22922, discussion #10601, squawkhq.com ban-concurrent-index-creation-in-transaction)
-- IF EXISTS: idempotente si un build previo quedó a medias o el índice ya no está.
DROP INDEX CONCURRENTLY IF EXISTS "trip"."outbox_events_published_at_created_at_idx";
