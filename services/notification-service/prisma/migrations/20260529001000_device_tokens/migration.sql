-- CreateEnum
CREATE TYPE "notification"."DevicePlatform" AS ENUM ('ios', 'android');

-- CreateTable: tokens de push por dispositivo (registro desde las apps vía BFF).
CREATE TABLE "notification"."device_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "notification"."DevicePlatform" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "notification"."device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "notification"."device_tokens"("user_id");
