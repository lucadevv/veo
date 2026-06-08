-- ADR 011 · dispatch_mode: modo de despacho/pricing CONGELADO del viaje (PUJA | FIXED).
-- Regla de oro resolve-once-persist-forever: el modo se resuelve UNA vez en createTrip y NO cambia
-- el resto de la vida del viaje (reasignación y activación de programados leen ESTE modo, nunca
-- re-resuelven de la config admin actual). DEFAULT FIXED: las filas LEGACY son todas precio-fijo
-- (el flujo previo sin puja). M1 lo persiste desde la rama isBid de createTrip (puja ⇒ PUJA, tarifa
-- por ruta ⇒ FIXED); M3 cambia la derivación por el ModeResolver pero sigue persistiendo aquí.
-- Ver trip-service/prisma/schema.prisma model Trip + enum PricingMode.

-- CreateEnum
CREATE TYPE "trip"."PricingMode" AS ENUM ('PUJA', 'FIXED');

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "dispatch_mode" "trip"."PricingMode" NOT NULL DEFAULT 'FIXED';
