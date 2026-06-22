-- AlterTable
-- F1 FIX 2: idempotencia de REQUEST del publish() (POST /published-trips), namespaceada por driverId.
-- Columna NULLABLE: solo publish() la usa; update()/cancel() mutan la fila existente (no dedupean).
ALTER TABLE "booking"."published_trips" ADD COLUMN "dedup_key" TEXT;

-- CreateIndex
-- @@unique([dedupKey]) = DEFENSA ANTI-IDOR cross-tenant: dos conductores con el mismo Idempotency-Key
-- derivan dedupKeys distintas (namespaceadas por driverId) → nunca colisionan. NULLs no chocan el UNIQUE
-- en Postgres (cada NULL es distinto) → ofertas sin dedupKey conviven sin problema.
CREATE UNIQUE INDEX "published_trips_dedup_key_key" ON "booking"."published_trips"("dedup_key");
