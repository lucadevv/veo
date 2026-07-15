-- CreateEnum
CREATE TYPE "media"."VideoRenderStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "media"."video_access_requests" ADD COLUMN     "render_status" "media"."VideoRenderStatus",
ADD COLUMN     "rendered_s3_key" TEXT,
ADD COLUMN     "render_requested_at" TIMESTAMPTZ,
ADD COLUMN     "rendered_at" TIMESTAMPTZ,
ADD COLUMN     "render_error" TEXT,
ADD COLUMN     "render_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "video_access_requests_render_status_render_requested_at_idx" ON "media"."video_access_requests"("render_status", "render_requested_at");
