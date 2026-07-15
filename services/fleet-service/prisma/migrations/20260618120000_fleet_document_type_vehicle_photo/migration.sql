-- Ola 1 "solo autos": foto del vehículo (VEHICLE_PHOTO) en el enum FleetDocumentType. Foto del auto
-- capturada en el alta del conductor (sin número ni vencimiento); requerida para aprobar (gate admin-bff).
-- ADD VALUE IF NOT EXISTS = idempotente y prod-safe (no recrea el tipo ni reescribe filas).
ALTER TYPE "fleet"."FleetDocumentType" ADD VALUE IF NOT EXISTS 'VEHICLE_PHOTO';
