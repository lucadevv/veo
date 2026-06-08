-- Sign in with Apple (App Store Guideline 4.8): nuevo valor del enum AuthMethodType para la
-- credencial soberana APPLE_OAUTH (espejo de GOOGLE_OAUTH, mismo modelo de account-linking).

-- AlterEnum
ALTER TYPE "identity"."AuthMethodType" ADD VALUE 'APPLE_OAUTH';
