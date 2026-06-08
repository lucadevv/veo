-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN     "face_embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "kyc_verified_at" TIMESTAMPTZ;

