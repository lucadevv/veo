-- AlterEnum
ALTER TYPE "identity"."AdminStatus" ADD VALUE 'INVITED';

-- AlterTable
ALTER TABLE "identity"."admin_users" ADD COLUMN     "invite_expires_at" TIMESTAMPTZ,
ADD COLUMN     "invite_token_hash" TEXT,
ALTER COLUMN "password_hash" DROP NOT NULL;
