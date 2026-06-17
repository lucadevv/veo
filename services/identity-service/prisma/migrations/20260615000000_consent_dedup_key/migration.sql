-- AlterTable: clave de idempotencia (UUIDv7) cliente-generada para el registro de consentimiento.
-- Nullable (aditiva, sin default): los consents históricos quedan en NULL. Postgres permite múltiples
-- NULL en un índice UNIQUE → el append-only puro (clientes sin dedupKey) sigue funcionando; solo los
-- submits CON dedupKey colisionan y se vuelven no-op idempotente (espeja panic_events.dedup_key).
ALTER TABLE "identity"."consents" ADD COLUMN "dedup_key" TEXT;

-- CreateIndex: UNIQUE sobre dedup_key (mismo naming que panic_events_dedup_key_key).
CREATE UNIQUE INDEX "consents_dedup_key_key" ON "identity"."consents"("dedup_key");
