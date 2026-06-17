-- B5-2.c · una solicitud de modelo (PENDING_REVIEW) la crea el conductor con lo que conoce
-- (make/model/año/asientos); los campos técnicos los completa el OPERADOR al aprobar. Por eso pasan a
-- nullable. La invariante "APPROVED ⇒ los 3 llenos" se fuerza en la transición de aprobación (servicio).
ALTER TABLE "fleet"."vehicle_model_specs" ALTER COLUMN "segment" DROP NOT NULL;
ALTER TABLE "fleet"."vehicle_model_specs" ALTER COLUMN "energy_source" DROP NOT NULL;
ALTER TABLE "fleet"."vehicle_model_specs" ALTER COLUMN "efficiency" DROP NOT NULL;
