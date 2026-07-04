-- Blind index del DNI del conductor (hashPii determinista con DNI_HASH_SALT): permite CHEQUEAR unicidad
-- sin exponer la PII (Ley 29733), ya que `document_id_enc` es cifrado con IV aleatorio (no indexable).
-- Nullable (migración segura, sin backfill): null = el conductor aún no registró su DNI. Postgres permite
-- múltiples NULL bajo un índice único, así que el UNIQUE no colisiona con las filas existentes sin DNI.
-- AlterTable
ALTER TABLE "identity"."drivers" ADD COLUMN "dni_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "drivers_dni_hash_key" ON "identity"."drivers"("dni_hash");
