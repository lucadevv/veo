-- ADR-012 Lote 1: tabla AuthMethod (auth multi-método soberano) + backfill de los usuarios
-- existentes (todos por teléfono) con su AuthMethod{PHONE_OTP, verified}.

-- CreateEnum
CREATE TYPE "identity"."AuthMethodType" AS ENUM ('PHONE_OTP', 'EMAIL_PASSWORD', 'GOOGLE_OAUTH');

-- AlterTable: el teléfono pasa a ser opcional (un usuario puede entrar solo por correo/Google).
-- Sigue siendo UNIQUE (Postgres permite múltiples NULL), no se rompe el login por teléfono.
ALTER TABLE "identity"."users" ALTER COLUMN "phone" DROP NOT NULL;

-- CreateTable
CREATE TABLE "identity"."auth_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "identity"."AuthMethodType" NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "oauth_subject" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "auth_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_methods_user_id_type_key" ON "identity"."auth_methods"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "auth_methods_type_email_key" ON "identity"."auth_methods"("type", "email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_methods_type_oauth_subject_key" ON "identity"."auth_methods"("type", "oauth_subject");

-- AddForeignKey
ALTER TABLE "identity"."auth_methods" ADD CONSTRAINT "auth_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: los usuarios existentes entraron todos por teléfono → crearles su AuthMethod{PHONE_OTP, verified}.
-- Idempotente: ON CONFLICT sobre (user_id, type) no duplica si se re-corre.
INSERT INTO "identity"."auth_methods" ("user_id", "type", "verified", "created_at", "updated_at")
SELECT "id", 'PHONE_OTP'::"identity"."AuthMethodType", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "identity"."users"
WHERE "phone" IS NOT NULL
ON CONFLICT ("user_id", "type") DO NOTHING;
