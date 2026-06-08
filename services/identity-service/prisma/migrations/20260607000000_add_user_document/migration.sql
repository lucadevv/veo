-- CreateEnum: tipo de documento del pasajero para pagos (ProntoPaga · Yape On File)
CREATE TYPE "identity"."DocumentType" AS ENUM ('DN', 'CE', 'PP');

-- AlterTable: documento de identidad del pasajero en el PERFIL (Yape de UN TAP, patrón PedidosYa).
-- Aditivo y nullable: no afecta filas existentes.
ALTER TABLE "identity"."users" ADD COLUMN     "document_type" "identity"."DocumentType",
ADD COLUMN     "document" TEXT;
