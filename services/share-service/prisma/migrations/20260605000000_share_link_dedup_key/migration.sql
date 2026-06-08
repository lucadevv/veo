-- AlterTable
ALTER TABLE "share"."share_links" ADD COLUMN "dedup_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "share_links_dedup_key_key" ON "share"."share_links"("dedup_key");
