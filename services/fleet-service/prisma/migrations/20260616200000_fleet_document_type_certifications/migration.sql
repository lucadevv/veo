-- B5-3.2 · certificaciones de operador de las verticales especiales (conductor) en el enum
-- FleetDocumentType. Misma maquinaria FleetDocument (vencimiento + review del operador). Las verticales
-- permanecen OCULTAS (defaultEnabled:false); estas certs solo gatean la eligibilidad cuando se habiliten.
-- ADD VALUE IF NOT EXISTS = idempotente y prod-safe (no recrea el tipo ni reescribe filas).
ALTER TYPE "fleet"."FleetDocumentType" ADD VALUE IF NOT EXISTS 'AMBULANCE_OPERATOR';
ALTER TYPE "fleet"."FleetDocumentType" ADD VALUE IF NOT EXISTS 'TOW_OPERATOR';
ALTER TYPE "fleet"."FleetDocumentType" ADD VALUE IF NOT EXISTS 'MECHANIC_CERT';
