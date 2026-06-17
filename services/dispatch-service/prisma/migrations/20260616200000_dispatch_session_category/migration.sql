-- B5-3.1.c · la sesión de matching guarda la oferta del viaje (offeringId) para que el advance resuelva
-- sus requisitos de eligibilidad (segment/seats/antigüedad) y filtre el pool. Nullable: viajes sin
-- category (legacy/desconocida) no restringen (el pool sigue filtrando solo por vehicleType).
ALTER TABLE "dispatch"."dispatch_sessions" ADD COLUMN IF NOT EXISTS "category" TEXT;
