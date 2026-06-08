-- Ola 2A · Promociones / cupones (payment-service).
-- Descuento aplicado SOLO al pasajero sobre el bruto; comisión y propina intactas.

-- CreateEnum
CREATE TYPE "payment"."PromoKind" AS ENUM ('PERCENTAGE', 'FIXED');

-- AlterTable
ALTER TABLE "payment"."payments" ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment"."promotions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "payment"."PromoKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "max_discount_cents" INTEGER,
    "min_fare_cents" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "max_total_uses" INTEGER NOT NULL DEFAULT 0,
    "max_uses_per_user" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."promo_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "discount_cents" INTEGER NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "payment"."promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_active_idx" ON "payment"."promotions"("active");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_dedup_key_key" ON "payment"."promo_redemptions"("dedup_key");

-- CreateIndex
CREATE INDEX "promo_redemptions_promotion_id_user_id_idx" ON "payment"."promo_redemptions"("promotion_id", "user_id");

-- CreateIndex
CREATE INDEX "promo_redemptions_trip_id_idx" ON "payment"."promo_redemptions"("trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_promotion_id_user_id_trip_id_key" ON "payment"."promo_redemptions"("promotion_id", "user_id", "trip_id");

-- AddForeignKey
ALTER TABLE "payment"."promo_redemptions" ADD CONSTRAINT "promo_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "payment"."promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
