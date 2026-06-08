-- PUJA (ADR 010 §4 · N7) · agreed_fare_cents: guard idempotente-POR-EVENTO de applyAgreedFare.
-- El precio ACORDADO al aceptar la oferta se escribe UNA sola vez aquí. Una redelivery at-least-once del
-- dispatch.offer_accepted tras un changeDestination (que recalculó fare_cents) NO puede revertir la
-- tarifa: si agreed_fare_cents ya está seteado, applyAgreedFare es no-op. Cierra el lost-update / corrupción
-- de tarifa. Nullable: null = la puja aún no acordó precio (viaje legacy sin bid, o evento no consumido).
-- Ver schema.prisma model Trip.

-- AlterTable
ALTER TABLE "trip"."trips" ADD COLUMN "agreed_fare_cents" INTEGER;
