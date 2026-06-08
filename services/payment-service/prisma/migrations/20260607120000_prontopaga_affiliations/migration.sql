-- ProntoPaga L1: método PAGOEFECTIVO, checkout externo en Payment, afiliaciones Yape On File.

-- AlterEnum: nuevo método de pago PagoEfectivo (patrón ALTER TYPE ... ADD VALUE, como APPLE_OAUTH).
ALTER TYPE "payment"."PaymentMethod" ADD VALUE 'PAGOEFECTIVO';

-- CreateEnum: estado de afiliación de wallet.
CREATE TYPE "payment"."AffiliationStatus" AS ENUM ('PROCESS', 'ACTIVE', 'EXPIRED', 'REVOKED');

-- AlterTable: campos de checkout externo (ProntoPaga PENDING_EXTERNAL) en payments.
ALTER TABLE "payment"."payments"
  ADD COLUMN "external_uid" TEXT,
  ADD COLUMN "checkout_url" TEXT,
  ADD COLUMN "qr_code" TEXT,
  ADD COLUMN "deep_link" TEXT,
  ADD COLUMN "cip" TEXT,
  ADD COLUMN "checkout_expires_at" TIMESTAMPTZ;

-- CreateTable: afiliaciones de wallet (Yape On File).
CREATE TABLE "payment"."wallet_affiliations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PRONTOPAGA',
    "wallet" TEXT NOT NULL DEFAULT 'YAPE',
    "type" TEXT NOT NULL DEFAULT 'RECURRENT',
    "status" "payment"."AffiliationStatus" NOT NULL DEFAULT 'PROCESS',
    "wallet_uid" TEXT,
    "phone_masked" TEXT,
    "document_masked" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wallet_affiliations_pkey" PRIMARY KEY ("id")
);

-- Una sola afiliación por (user, provider, wallet).
CREATE UNIQUE INDEX "wallet_affiliations_user_id_provider_wallet_key" ON "payment"."wallet_affiliations"("user_id", "provider", "wallet");
CREATE INDEX "wallet_affiliations_status_idx" ON "payment"."wallet_affiliations"("status");
CREATE INDEX "wallet_affiliations_wallet_uid_idx" ON "payment"."wallet_affiliations"("wallet_uid");
