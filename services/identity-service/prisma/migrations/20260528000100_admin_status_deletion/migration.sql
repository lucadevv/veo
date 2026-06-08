-- CreateEnum
CREATE TYPE "identity"."AdminStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- AlterTable
ALTER TABLE "identity"."admin_users" DROP COLUMN "active",
ADD COLUMN     "status" "identity"."AdminStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ;

