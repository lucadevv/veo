-- AlterTable: enrolamiento facial del conductor (BR-I02)
ALTER TABLE "identity"."drivers" ADD COLUMN     "face_embedding" DOUBLE PRECISION[],
ADD COLUMN     "face_enrolled_at" TIMESTAMPTZ;
