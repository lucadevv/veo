-- CreateEnum
CREATE TYPE "identity"."ReferralStatus" AS ENUM ('PENDING', 'REWARDED');

-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN     "referral_code" TEXT,
ADD COLUMN     "referral_reward_cents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "identity"."referrals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "referrer_user_id" UUID NOT NULL,
    "referred_user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "identity"."ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "reward_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewarded_at" TIMESTAMPTZ,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_user_id_key" ON "identity"."referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_user_id_idx" ON "identity"."referrals"("referrer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "identity"."users"("referral_code");

