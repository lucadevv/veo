-- B5-2.b · el vehículo del conductor referencia el modelo del catálogo que ELIGIÓ en el onboarding.
-- Referencia blanda (sin FK dura): el catálogo puede evolucionar sin bloquear el vehículo. Nullable:
-- los vehículos legacy/cargados a texto libre quedan en NULL.
ALTER TABLE "fleet"."vehicles" ADD COLUMN IF NOT EXISTS "model_spec_id" UUID;

CREATE INDEX IF NOT EXISTS "vehicles_model_spec_id_idx"
  ON "fleet"."vehicles" ("model_spec_id");
