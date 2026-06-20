-- CreateEnum
CREATE TYPE "identity"."SuspensionSource" AS ENUM ('DISCIPLINARY', 'DOCUMENT_EXPIRED');

-- AlterTable
ALTER TABLE "identity"."drivers" ADD COLUMN     "suspension_source" "identity"."SuspensionSource";
