-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateEnum
CREATE TYPE "identity"."UserType" AS ENUM ('PASSENGER', 'DRIVER');

-- CreateEnum
CREATE TYPE "identity"."KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "identity"."DriverStatus" AS ENUM ('OFFLINE', 'AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'ON_BREAK', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "identity"."BackgroundCheckStatus" AS ENUM ('PENDING', 'CLEARED', 'REJECTED');

-- CreateEnum
CREATE TYPE "identity"."BiometricCheckType" AS ENUM ('SHIFT_START', 'REVERIFY', 'ONBOARDING');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "type" "identity"."UserType" NOT NULL,
    "photo_url" TEXT,
    "dni_hash" TEXT,
    "kyc_status" "identity"."KycStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."drivers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "license_number" TEXT,
    "license_expires_at" TIMESTAMPTZ,
    "current_status" "identity"."DriverStatus" NOT NULL DEFAULT 'OFFLINE',
    "average_rating" DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    "total_trips" INTEGER NOT NULL DEFAULT 0,
    "background_check_status" "identity"."BackgroundCheckStatus" NOT NULL DEFAULT 'PENDING',
    "last_verified_at" TIMESTAMPTZ,
    "suspended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "roles" TEXT[],
    "totp_secret_enc" TEXT,
    "totp_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."biometric_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "identity"."BiometricCheckType" NOT NULL,
    "score" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "capture_ref" TEXT,
    "geo_lat" DOUBLE PRECISION,
    "geo_lon" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "identity"."users"("phone");

-- CreateIndex
CREATE INDEX "users_kyc_status_idx" ON "identity"."users"("kyc_status");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "identity"."drivers"("user_id");

-- CreateIndex
CREATE INDEX "drivers_current_status_idx" ON "identity"."drivers"("current_status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "identity"."admin_users"("email");

-- CreateIndex
CREATE INDEX "biometric_checks_user_id_created_at_idx" ON "identity"."biometric_checks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "identity"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "identity"."drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."biometric_checks" ADD CONSTRAINT "biometric_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

