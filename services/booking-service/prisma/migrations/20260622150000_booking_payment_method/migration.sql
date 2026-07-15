-- F3b · ADR-014 §5.5 (decisión del dueño 2026-06-22): el PASAJERO ELIGE el método de pago al RESERVAR.
-- Se persiste en el Booking; el CHARGE al aprobar (o al reservar si INSTANT) lo usa.

-- CreateEnum: cara LOCAL del PaymentMethod de @veo/shared-types (DB-per-service; no se importa la tabla de payment).
CREATE TYPE "booking"."PaymentMethod" AS ENUM ('YAPE', 'PLIN', 'CASH', 'CARD', 'PAGOEFECTIVO');

-- AddColumn: paymentMethod OBLIGATORIO. Se agrega con un DEFAULT transitorio ('YAPE') para no romper filas
-- preexistentes (Postgres lo aplica a las existentes), y acto seguido se QUITA el default para que TODA fila
-- nueva DEBA traer su método explícito desde el DTO (@IsEnum) — el default no debe enmascarar un método ausente.
ALTER TABLE "booking"."bookings" ADD COLUMN "payment_method" "booking"."PaymentMethod" NOT NULL DEFAULT 'YAPE';
ALTER TABLE "booking"."bookings" ALTER COLUMN "payment_method" DROP DEFAULT;
