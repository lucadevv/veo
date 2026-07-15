-- AlterTable
ALTER TABLE "payment"."commission_config" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payment"."payments" ADD COLUMN     "dispatch_mode" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "origin_lat" DOUBLE PRECISION,
ADD COLUMN     "origin_lng" DOUBLE PRECISION;
