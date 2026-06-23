import type { EventDedupOptions } from '@veo/events';

/**
 * Namespace Redis de dedup de booking-service, para sus consumers Kafka (hoy: BookingPaymentConsumer ·
 * payment.captured/failed · F3c). Nunca compartirlo con otro servicio: un eventId procesado por booking NO
 * cuenta como procesado por otro (el prefijo aísla el espacio de claves por servicio · @veo/events/dedup).
 *
 * El dedup por eventId es UNA de las DOS barreras de idempotencia del seat-lock (§6): marca DESPUÉS del éxito
 * (si el handler falla, no se escribe → kafkajs reintenta). La OTRA barrera, la dura, es el `where` atómico
 * `estado: COBRO_PENDIENTE` del UPDATE dentro de la txn — esa tolera duplicado Y reorden aunque el dedup
 * expirara. Juntas: nunca doble-decremento (no oversold por reproceso).
 */
export const BOOKING_PAYMENT_EVENT_DEDUP: EventDedupOptions = {
  keyPrefix: 'veo:booking:payment-dedup:',
};
