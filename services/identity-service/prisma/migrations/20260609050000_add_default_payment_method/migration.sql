-- Método de pago por defecto del pasajero (preferencia de UI, sembrada en el selector al pedir viaje).
-- TEXT (no enum de DB): se valida contra el enum compartido PaymentMethod en el borde DTO. Nullable:
-- null = el usuario nunca lo eligió → la app cae a su default local.
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "default_payment_method" TEXT;
