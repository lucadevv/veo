-- LOTE 1 · la TARJETA DE PROPIEDAD es la fuente de verdad del tipo de vehículo. Persistimos la categoría MTC
-- CRUDA leída de la tarjeta (`M1`, `L3`, `N1`, `M1SC`…): el servidor DERIVA `vehicle_type` de acá (M1→CAR,
-- L*→MOTO; resto→hint del body). Se guarda cruda para auditoría/re-derivación si el enum `VehicleType` se
-- amplía a futuro. Migración ADITIVA y prod-safe (columna nullable, sin reescribir filas existentes):
--   - Null = alta sin categoría (carga manual del tipo) o vehículo legacy/operador (pre-LOTE 1).
-- Ver fleet-service/prisma/schema.prisma (model Vehicle).

-- AlterTable
ALTER TABLE "fleet"."vehicles" ADD COLUMN IF NOT EXISTS "mtc_category" TEXT;
