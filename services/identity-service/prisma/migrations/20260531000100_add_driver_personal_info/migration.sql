-- AlterTable: datos personales del conductor (BR-I04 cumplimiento)
ALTER TABLE "identity"."drivers" ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "document_id" TEXT,
ADD COLUMN     "birth_date" DATE;
