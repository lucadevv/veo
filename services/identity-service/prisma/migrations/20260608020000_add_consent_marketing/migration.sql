-- AlterTable: flag de consentimiento de marketing/promociones (opt-in, Ley 29733).
-- Default false: los consents existentes quedan opt-out (nadie recibe promos sin aceptar explícitamente).
ALTER TABLE "identity"."consents" ADD COLUMN "marketing" BOOLEAN NOT NULL DEFAULT false;
