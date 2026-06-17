-- CreateEnum
CREATE TYPE "media"."VideoAccessStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "media"."video_access_requests" ADD COLUMN     "rejected_at" TIMESTAMPTZ,
ADD COLUMN     "rejected_by" UUID,
ADD COLUMN     "status" "media"."VideoAccessStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "video_access_requests_status_created_at_idx" ON "media"."video_access_requests"("status", "created_at");
