-- Money del referido (FOUNDATION §8): currency OBLIGATORIA junto a TODO campo de dinero del dominio.
-- Hoy única moneda 'PEN' (mismo patrón que payment-service: `currency String @default("PEN")`).
-- NOT NULL DEFAULT constante = backfill implícito de las filas existentes sin rewrite de tabla (PG 11+).
-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN "referral_reward_currency" TEXT NOT NULL DEFAULT 'PEN';

-- AlterTable
ALTER TABLE "identity"."referrals" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'PEN';
