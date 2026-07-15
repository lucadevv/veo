-- F3c-payment · Refund automático system-initiated por `booking.cancelled` (ASIENTO_LLENO / OFERTA_NO_DISPONIBLE).
-- `dedup_key` es la clave de idempotencia determinista (`booking-cancel-refund:{bookingId}`) del refund
-- system-initiated. Aditivo y nullable: los refunds ADMIN discrecionales existentes quedan con dedup_key = NULL
-- (su idempotencia es el CAS optimista del Payment) y NO se ven afectados. Espeja `tip_additions.dedup_key`.

ALTER TABLE "payment"."refunds" ADD COLUMN "dedup_key" TEXT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- UNIQUE PARCIAL (Prisma NO lo modela → vive a mano acá; ver el comentario del campo en schema.prisma).
--
-- La unicidad corre SOLO sobre los refunds ACTIVOS (status <> 'REJECTED'):
--   · Un refund PENDING/APPROVED/COMPLETED con esa key BLOQUEA un 2do create (P2002) → NO doble-refund:
--     un `booking.cancelled` duplicado/reordenado (Kafka at-least-once) no devuelve la plata dos veces.
--   · Un refund REJECTED por el proveedor NO participa del índice → el reintento legítimo del MISMO
--     `booking.cancelled` puede crear un Refund NUEVO → la plata SE DEVUELVE aunque el 1er reverso fallara.
--
-- POR QUÉ PARCIAL Y NO `@unique` GLOBAL (la causa raíz del refund-starvation): con un UNIQUE total, tras UN
-- solo rechazo del proveedor (Refund REJECTED, dedup_key sin limpiar) el reintento chocaría P2002 → el caller
-- (`refundForBookingCancellation`) lo traduce a `{ skipped }` → el pasajero que pagó y no viajó NUNCA recibiría
-- su refund automático. Viola el invariante ADR-014 §6 ("refund OBLIGATORIO"): la barrera anti-doble-refund se
-- volvía barrera anti-refund. El índice parcial mantiene AMBOS invariantes: NO doble-refund Y devolver SIEMPRE.
--
-- REJECTED es el ÚNICO estado terminal-de-fallo del enum RefundStatus (PENDING/APPROVED/REJECTED/COMPLETED):
-- COMPLETED es terminal-de-éxito (debe seguir bloqueando), PENDING/APPROVED están en vuelo (deben bloquear).
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "refunds_dedup_key_active_key"
  ON "payment"."refunds" ("dedup_key")
  WHERE "status" <> 'REJECTED' AND "dedup_key" IS NOT NULL;

-- Índice NO-único para correlacionar el dedup_key al booking en el backstop admin de refunds REJECTED
-- system-initiated (dedup_key LIKE 'booking-cancel-refund:%'). Sin el UNIQUE total, varios Refund REJECTED
-- por key conviven (cada reintento/rechazo deja su fila durable que el admin ve); el índice acelera la búsqueda.
CREATE INDEX "refunds_dedup_key_idx" ON "payment"."refunds" ("dedup_key");
