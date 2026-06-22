/**
 * Eventos de dominio del booking-service (ADR-014 §7). Envelope único UUIDv7 + naming
 * `<domain>.<pastTease>`, topic Kafka 'booking'. El CONTRATO del payload (los schemas Zod) vive en
 * `@veo/events` (registro central `EVENT_SCHEMAS`) para que los consumidores validen lo que reciben;
 * acá solo se centraliza la lista TIPADA de los eventos que este servicio emite — CERO strings mágicos
 * en los services (se usa `BookingEventType.X`, no el literal).
 *
 * F0 emite (ADR-014 §7.1, mapeo alineado):
 *  - booking.published → se PUBLICA un PublishedTrip (la OFERTA del conductor, BORRADOR → PUBLICADO).
 *  - booking.requested → se crea un Booking en modo REVISION (→ PENDIENTE_APROBACION).
 *  - booking.approved  → se crea un Booking en modo INSTANT (nace APROBADO, salta PENDIENTE_APROBACION, §4.2).
 * El resto de los eventos del ADR-014 §7.1 (rejected/expired/confirmed/started/completed/cancelled) se
 * emiten en F1-F4; se DECLARAN acá y en @veo/events desde ya para que el contrato exista, pero su emisión
 * se difiere honestamente a la fase que la gatilla.
 *
 * NOMBRE corregido (era `booking.created` para la PUBLICACIÓN de la oferta — invertido respecto a §7.1, que
 * reserva `booking.created` para "se crea un Booking"). Se renombra a `booking.published` para que el nombre
 * refleje el agregado real (el PublishedTrip), sin cambiar el topic 'booking'.
 */

/** Eventos de dominio que emite el booking-service (topic 'booking'). Fuente única tipada. */
export const BookingEventType = {
  // ── F0 (este lote) ──
  /// Se publicó un PublishedTrip (la oferta del conductor pasó a BORRADOR → PUBLICADO).
  PUBLISHED: 'booking.published',
  /// Se creó un Booking en modo REVISION (la reserva del pasajero queda PENDIENTE_APROBACION).
  REQUESTED: 'booking.requested',
  /// Booking APROBADO: en F0, INSTANT_BOOKING (nace APROBADO al reservar). La aprobación del conductor es F1.
  APPROVED: 'booking.approved',

  // ── F1a (este lote) ──
  /// El conductor EDITÓ su oferta publicada (itinerario/precio/asientos/modoReserva/reglas), aún editable
  /// (PUBLICADO, sin reservas confirmadas / pre-EN_RUTA). Espeja PUBLISHED: outbox-en-transacción.
  UPDATED: 'booking.updated',

  // ── F1-F4 (declarados, emisión diferida) ──
  /// El conductor rechazó la solicitud (F1).
  REJECTED: 'booking.rejected',
  /// TTL ~5min sin respuesta → EXPIRADO (F1).
  EXPIRED: 'booking.expired',
  /// payment.captured consumido → CONFIRMADO (F3).
  CONFIRMED: 'booking.confirmed',
  /// PublishedTrip → EN_RUTA: trip-service crea el Trip en vivo (F4).
  STARTED: 'booking.started',
  /// El viaje terminó (F4/F5).
  COMPLETED: 'booking.completed',
  /// Cancelación (con tier) o cobro fallido / asiento-lleno → payment-service gestiona el Refund (F3/F5).
  CANCELLED: 'booking.cancelled',
} as const;

export type BookingEventType = (typeof BookingEventType)[keyof typeof BookingEventType];

/** Productor canónico de los eventos del servicio (campo `producer` del envelope). */
export const BOOKING_PRODUCER = 'booking-service';
