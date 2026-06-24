-- Outbox SEQ — secuencia monotónica de INSERCIÓN como tiebreak DETERMINISTA del orden intra-tx
-- (@veo/database PrismaOutboxStore). CAUSA RAÍZ: dos eventos del MISMO aggregate emitidos en la MISMA tx
-- comparten created_at (= transaction_timestamp del default now()) AL µs; el desempate viejo por eventId
-- (uuidv7) es RANDOM dentro del mismo ms → orden de publicación no-determinista → el consumer (Kafka ordena
-- por key=aggregateId) los ve fuera de orden. `seq` (orden de inserción estricto) lo cierra de raíz.
--
-- NO-BLOQUEANTE — outbox_events es una tabla VIVA (cada tx de dominio inserta vía enqueueOutbox), así que el
-- ADD COLUMN no puede REESCRIBIR la tabla (un rewrite toma ACCESS EXCLUSIVE y bloquea los INSERT de negocio).
-- La doc oficial de PG16 (sql-altertable, "Notes") es explícita: ADD COLUMN con un DEFAULT VOLÁTIL (nextval()
-- de una secuencia LO ES) o una columna IDENTITY/BIGSERIAL "require the entire table and its indexes to be
-- rewritten". En cambio, ADD COLUMN nullable SIN default es metadata-only ("In neither case is a rewrite of the
-- table required"). Por eso NO usamos `ADD COLUMN seq BIGSERIAL` / `GENERATED ALWAYS AS IDENTITY` (reescriben);
-- lo hacemos en pasos que NO reescriben:
--   1) CREATE SEQUENCE  — no toca la tabla.
--   2) ADD COLUMN nullable SIN default — metadata-only (rápido, no reescribe).
--   3) SET DEFAULT nextval(seq) — metadata-only, afecta solo INSERTs FUTUROS (las nuevas filas obtienen seq).
--   4) OWNED BY — ata el ciclo de vida de la secuencia a la columna (drop de columna ⇒ drop de secuencia).
--   5) backfill de las filas VIEJAS (seq IS NULL) por (created_at, id): un UPDATE solo bloquea las filas que
--      toca, NUNCA los INSERT nuevos. El orden ENTRE filas viejas es arbitrario salvo el created_at, pero esas
--      ya se publicaron o se publicarán y su orden relativo intra-tx exacto es histórico (irrecuperable) — lo
--      que el fix protege es el orden de las filas NUEVAS, que sí nacen con seq monotónico.
--   6) SET NOT NULL — el modelo Prisma declara `seq BigInt` (NOT NULL). Toma ACCESS EXCLUSIVE + scan para
--      validar que no quedan NULLs; es rápido mientras la tabla sea chica (estado de fundación: outbox casi
--      vacía, sin retención aún). Si la tabla creciera, migrar este paso al patrón CHECK NOT VALID → VALIDATE
--      → SET NOT NULL (no-bloqueante). Hoy el scan es trivial; lo dejamos simple y honesto.
--
-- El nombre de la secuencia (`outbox_events_seq_seq`) es el que Prisma espera para `@default(autoincrement())`
-- sobre la columna `seq` (convención `<tabla>_<columna>_seq`) → cero drift en `prisma migrate diff`.
-- Multi-statement: Prisma lo envuelve en UNA tx (atómico). Ninguno de estos statements reescribe ni es
-- CONCURRENTLY, así que la tx es legal (el índice nuevo con seq va en migraciones SEPARADAS, CONCURRENTLY).
CREATE SEQUENCE "dispatch"."outbox_events_seq_seq";
ALTER TABLE "dispatch"."outbox_events" ADD COLUMN "seq" BIGINT;
ALTER TABLE "dispatch"."outbox_events" ALTER COLUMN "seq" SET DEFAULT nextval('"dispatch"."outbox_events_seq_seq"');
ALTER SEQUENCE "dispatch"."outbox_events_seq_seq" OWNED BY "dispatch"."outbox_events"."seq";
-- Backfill ORDENADO: nextval se asigna siguiendo el ORDER BY del subquery (created_at, id) → las filas viejas
-- reciben seq coherente con su orden temporal (no el orden físico arbitrario de un UPDATE plano).
UPDATE "dispatch"."outbox_events" AS o
SET "seq" = s.rn
FROM (
  SELECT "id", nextval('"dispatch"."outbox_events_seq_seq"') AS rn
  FROM "dispatch"."outbox_events"
  WHERE "seq" IS NULL
  ORDER BY "created_at" ASC, "id" ASC
) AS s
WHERE o."id" = s."id";
ALTER TABLE "dispatch"."outbox_events" ALTER COLUMN "seq" SET NOT NULL;
