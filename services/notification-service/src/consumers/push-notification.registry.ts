/**
 * Registro DECLARATIVO de notificaciones push derivadas de eventos de dominio + su motor.
 *
 * Por qué existe (Lote P · promover patrones): el consumer tenía 22 handlers privados con el MISMO
 * esqueleto de ~35 líneas (safeParse → resolver tokens → warn-si-vacío → enqueue PUSH) donde lo
 * único que variaba era schema / destinatario / template / segmento del dedupKey / deep-link.
 * Agregar una notificación = editar la clase en 3 lugares + mantener a mano el `.on()` y el string
 * de log de suscripciones. Ahora: **agregar una notificación push = agregar UNA fila acá**; el
 * motor (`runPushSpec`) ejecuta el esqueleto común y `EventConsumerService` deriva suscripciones y
 * log del registro (muere el double-source).
 *
 * Qué NO vive acá — handlers DEDICADOS en `EventConsumerService` (ver `DEDICATED_EVENT_TYPES`):
 *  - `panic.triggered`: fan-out SMS a contactos + webhook firmado a la central (SLA p99 < 3s);
 *    no es un push a un usuario.
 *  - `payment.failed`: DOS rieles (push al pasajero + webhook a la central) y NO retorna si falta
 *    el token (la alerta a la central sale igual). Su dedupKey histórico además no lleva `:push:`.
 *  - `payment.cancellation_penalty_collected`: DOS destinatarios (pasajero + conductor con
 *    compensación condicional `driverCompensationCents > 0`).
 *
 * CONTRATOS de cada fila:
 *  - `schema` SIEMPRE es la referencia del registro central de @veo/events — `defineSpec` la fija
 *    solo (imposible re-declararla) y el contract test verifica la identidad. Los campos que el
 *    producer ENRIQUECE fuera del contrato (driverName, vehiclePlate…) van en `enrichment`,
 *    NUNCA re-declarando el contrato. El hint de transporte (token/platform directos en el
 *    evento) es transversal: `pushTargetHintSchema`, una sola declaración para todas las filas.
 *  - `dedup` devuelve el segmento ANTES de `:push:<token>` y es INMUTABLE: cambiarlo rompe la
 *    idempotencia de eventos en vuelo (Kafka es at-least-once).
 */
import { z } from 'zod';
import { EVENT_SCHEMAS, type EventEnvelope, type EventPayload, type EventType } from '@veo/events';
import { NotificationChannel, PanicStatus } from '@veo/shared-types';
import { NotificationPriority, type EnqueueInput } from '../engine/types';
import { TEMPLATE_KEYS, type TemplateKey } from '../engine/template.catalog';
import type { DeviceTarget } from '../devices/device-token.repository';

/* ────────────────────────────── tipos del registro ────────────────────────────── */

const pushPlatform = z.enum(['android', 'ios']);
export type PushPlatform = z.infer<typeof pushPlatform>;

/**
 * Hint de TRANSPORTE enriquecido (transversal a todas las filas): el producer puede adjuntar el
 * token push directo en el evento; si viaja, gana sobre el device-store. UNA declaración para
 * todo el registro — antes cada schema local lo re-declaraba (copy-paste x19).
 */
export const pushTargetHintSchema = z.object({
  passengerPushToken: z.string().optional(),
  platform: pushPlatform.optional(),
});

/** Payload que ven los callbacks de una fila: contrato del registro + enrichment de la fila. */
type SpecPayload<T extends EventType, E extends z.ZodTypeAny> = EventPayload<T> & z.infer<E>;

/**
 * Naturaleza del id que devuelve `recipient` (ADR-015 D7):
 *  - `'userId'` (DEFAULT): es la cuenta `userId` — clave directa del device-token store. La inmensa mayoría.
 *  - `'driverId'`: es el `Driver.id` del agregado del conductor (≠ userId). DEBE resolverse a `userId` por
 *    gRPC a identity ANTES del lookup de device-token, o el push NO matchea jamás (dos columnas UUID
 *    distintas). El caso vivo: `payout.processed` (el evento de payments targetea por Driver.id).
 */
export type RecipientKind = 'userId' | 'driverId';

/** Autoría TIPADA de una fila (lo que se escribe en `defineSpec`). */
interface PushSpecDefinition<T extends EventType, E extends z.ZodTypeAny> {
  /** Campos ENRIQUECIDOS por el producer fuera del contrato del registro (display/destinatario). */
  enrichment?: E;
  /** Gate de PRODUCTO: `false` ⇒ el evento se ignora sin warn (decisión deliberada, no gap). */
  when?: (p: SpecPayload<T, E>) => boolean;
  /**
   * Id destinatario: resuelve tokens del device-store y es el recipientId del enqueue. Por DEFAULT es el
   * `userId` (clave del store); si la fila declara `recipientKind: 'driverId'` el motor lo resuelve a
   * userId por gRPC a identity antes del lookup (ver `RecipientKind`).
   */
  recipient: (p: SpecPayload<T, E>) => string | undefined;
  /** Naturaleza del id que devuelve `recipient`. Omitir ⇒ `'userId'` (comportamiento de TODAS las filas previas). */
  recipientKind?: RecipientKind;
  /**
   * recipientId de REGISTRO cuando el push sale por token enriquecido sin userId (comportamiento
   * histórico `passengerId ?? tripId`). Sin fallback y sin userId ⇒ se omite con warn.
   */
  recipientFallback?: (p: SpecPayload<T, E>) => string;
  /** Template del catálogo. Tipado `TemplateKey` ⇒ existencia verificada en compile-time. */
  template: TemplateKey | ((p: SpecPayload<T, E>) => TemplateKey);
  /** Prioridad de drenado; omitir ⇒ Normal (default del engine). */
  priority?: NotificationPriority;
  /** Segmento del dedupKey ANTES de `:push:<token>`. INMUTABLE (idempotencia de eventos en vuelo). */
  dedup: (p: SpecPayload<T, E>, envelope: EventEnvelope<unknown>) => string;
  /** Variables del template ({{var}}). Omitir ⇒ {}. */
  vars?: (p: SpecPayload<T, E>) => Record<string, string | number>;
  /** `data` del push: deep-link (`screen` de PUSH_SCREEN) + ids que la app resuelve. */
  data: (p: SpecPayload<T, E>) => Record<string, string>;
}

type UnknownPayload = Record<string, unknown>;

/** Vista HOMOGÉNEA de una fila que consume el motor (payload opaco, ya validado). */
export interface PushNotificationSpec<T extends EventType = EventType> {
  eventType: T;
  /** Referencia (identidad, no copia) al schema del registro central de @veo/events. */
  schema: z.ZodType;
  enrichment?: z.ZodType;
  when?: (p: UnknownPayload) => boolean;
  recipient: (p: UnknownPayload) => string | undefined;
  recipientKind?: RecipientKind;
  recipientFallback?: (p: UnknownPayload) => string;
  template: TemplateKey | ((p: UnknownPayload) => TemplateKey);
  priority?: NotificationPriority;
  dedup: (p: UnknownPayload, envelope: EventEnvelope<unknown>) => string;
  vars?: (p: UnknownPayload) => Record<string, string | number>;
  data: (p: UnknownPayload) => Record<string, string>;
}

/**
 * Construye una fila: fija `schema` desde el registro central (single-source, imposible
 * re-declararlo) y borra los tipos hacia la vista del motor.
 *
 * El cast es BORRADO CONTROLADO: la autoría es 100% tipada (payload = `EventPayload<T>` +
 * enrichment) y el motor solo invoca los callbacks con el payload ya validado por
 * `schema` + `enrichment`, así que la vista opaca nunca miente.
 */
export function defineSpec<
  T extends EventType,
  E extends z.ZodTypeAny = z.ZodObject<Record<string, never>>,
>(eventType: T, def: PushSpecDefinition<T, E>): PushNotificationSpec<T> {
  return {
    eventType,
    schema: EVENT_SCHEMAS[eventType],
    ...def,
  } as unknown as PushNotificationSpec<T>;
}

/* ────────────────────────────── constantes de dominio ────────────────────────────── */

/** Pantallas de deep-link que la app resuelve al tocar el push (resolveDeepLink). Tipadas. */
export const PUSH_SCREEN = {
  OffersBoard: 'OffersBoard',
  TripActive: 'TripActive',
  CashConfirm: 'CashConfirm',
  CancellationPenalty: 'CancellationPenalty',
  Wallet: 'Wallet',
  Chat: 'Chat',
} as const;

/**
 * Copy por defecto cuando el producer no enriquece `driverName`. Drift resuelto: trip.assigned
 * usaba 'tu conductor' (minúscula) y el resto 'Tu conductor' — todos los templates lo interpolan
 * al INICIO de la oración, así que la capitalizada es la correcta.
 */
const DEFAULT_DRIVER_NAME = 'Tu conductor';

/** Vista previa del chat: no exponemos el mensaje completo en la notificación. */
const CHAT_PREVIEW_MAX = 60;
const CHAT_PREVIEW_SLICE = 57;

/** Formatea céntimos PEN a "X.XX" (el "S/" lo pone el template). 1850 → "18.50". */
export function formatSoles(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Segundos → minutos redondeados para el copy de ETA; 0/ausente ⇒ '' (el template lo omite). */
function etaMinutes(etaSeconds: number | undefined): string | number {
  return etaSeconds ? Math.round(etaSeconds / 60) : '';
}

/** Enrichment recurrente: nombre del conductor para personalizar el copy. */
const driverNameEnrichment = z.object({ driverName: z.string().optional() });

/* ────────────────────────────── el registro ────────────────────────────── */

export const PUSH_NOTIFICATION_SPECS = {
  /** trip.assigned → push al pasajero (token del evento o, si falta, los del almacén). */
  'trip.assigned': defineSpec('trip.assigned', {
    enrichment: z.object({
      passengerId: z.string().optional(),
      driverName: z.string().optional(),
      vehiclePlate: z.string().optional(),
      etaSeconds: z.number().optional(),
    }),
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.TRIP_ASSIGNED,
    dedup: (p) => `trip:${p.tripId}:assigned`,
    vars: (p) => ({
      driverName: p.driverName ?? DEFAULT_DRIVER_NAME,
      vehiclePlate: p.vehiclePlate ?? '',
      etaMinutes: etaMinutes(p.etaSeconds),
    }),
    data: (p) => ({ tripId: p.tripId, driverId: p.driverId }),
  }),

  /** trip.accepted → push al pasajero: "tu conductor confirmó". Deep-link al viaje activo. */
  'trip.accepted': defineSpec('trip.accepted', {
    enrichment: driverNameEnrichment,
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.TRIP_ACCEPTED,
    dedup: (p) => `trip:${p.tripId}:accepted`,
    vars: (p) => ({
      driverName: p.driverName ?? DEFAULT_DRIVER_NAME,
      etaMinutes: etaMinutes(p.etaSeconds),
    }),
    data: (p) => ({ tripId: p.tripId, driverId: p.driverId, screen: PUSH_SCREEN.TripActive }),
  }),

  /** trip.started → push al pasajero: "tu viaje empezó" (dispara el dominó de compartir/familia). */
  'trip.started': defineSpec('trip.started', {
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.TRIP_STARTED,
    dedup: (p) => `trip:${p.tripId}:started`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * RC5 (ADR-022) · trip.destination_changed → push CRÍTICO al PASAJERO dueño de la cuenta (padre/madre) SOLO en
   * modo niño: alguien reescribió el destino del viaje del menor y hasta ahora era invisible (changeDestination no
   * publicaba al outbox). `when: childMode` evita spamear los viajes normales (un pasajero que cambia SU propio
   * destino ya sabe que lo hizo). Priority Critical: seguridad infantil, drena antes que los transaccionales (misma
   * política que child_code_failed). dedup por `eventId`: cada cambio de destino (evento distinto) vuelve a alertar,
   * pero una redelivery del MISMO cambio dedup. Sin passengerId enriquecido no hay destinatario (gate de producto).
   */
  'trip.destination_changed': defineSpec('trip.destination_changed', {
    when: (p) => p.childMode === true,
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.TRIP_DESTINATION_CHANGED,
    priority: NotificationPriority.Critical,
    dedup: (p, envelope) => `trip:${p.tripId}:destination_changed:${envelope.eventId}`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.TripActive }),
  }),

  /** trip.arriving → push al pasajero: "tu conductor está llegando" (el más importante del ride-hailing). */
  'trip.arriving': defineSpec('trip.arriving', {
    enrichment: driverNameEnrichment,
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.TRIP_ARRIVING,
    dedup: (p) => `trip:${p.tripId}:arriving`,
    vars: (p) => ({ driverName: p.driverName ?? DEFAULT_DRIVER_NAME }),
    data: (p) => ({ tripId: p.tripId, driverId: p.driverId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * trip.arrived → "tu conductor llegó". Si el evento trae la ventana de espera
   * (waitWindowSeconds) usa el template que la incluye; si no, el simple. NO inventamos la ventana.
   */
  'trip.arrived': defineSpec('trip.arrived', {
    enrichment: driverNameEnrichment,
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: (p) =>
      p.waitWindowSeconds !== undefined
        ? TEMPLATE_KEYS.TRIP_ARRIVED_WAIT
        : TEMPLATE_KEYS.TRIP_ARRIVED,
    dedup: (p) => `trip:${p.tripId}:arrived`,
    vars: (p) => ({
      driverName: p.driverName ?? DEFAULT_DRIVER_NAME,
      ...(p.waitWindowSeconds !== undefined
        ? { waitMinutes: Math.round(p.waitWindowSeconds / 60) }
        : {}),
    }),
    data: (p) => ({ tripId: p.tripId, driverId: p.driverId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * #1 · trip.bid_posted(scheduled=true) → push con deep-link al BOARD. Cierra el dead-end de la
   * PUJA programada: la reserva se activa sola (cron) y el pasajero no está en la app. La puja
   * inmediata y el rebid (scheduled=false/ausente) NO pushean: el pasajero ya está mirando el board.
   */
  'trip.bid_posted': defineSpec('trip.bid_posted', {
    when: (p) => p.scheduled === true,
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_SCHEDULED_READY,
    dedup: (p) => `trip:${p.tripId}:scheduled_ready`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.OffersBoard }),
  }),

  /**
   * H3 · trip.reassigning → "tu conductor canceló, volvé a elegir", deep-link al board re-abierto.
   * negotiationSeq no entra al dedup: una reasignación = un push; redeliveries del mismo evento dedup.
   */
  'trip.reassigning': defineSpec('trip.reassigning', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_REASSIGNING,
    dedup: (p) => `trip:${p.tripId}:reassigning`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.OffersBoard }),
  }),

  /**
   * H3 · trip.completed → push de RECIBO al pasajero, deep-link al detalle (`TripActive` muestra el
   * estado final). Sin passengerId (compat N-2) se omite silencioso — gate de producto, no gap.
   */
  'trip.completed': defineSpec('trip.completed', {
    when: (p) => p.passengerId !== undefined,
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_COMPLETED,
    dedup: (p) => `trip:${p.tripId}:completed`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * trip.cancelled → confirmación HONESTA al pasajero. by=PASSENGER → "cancelaste tu viaje";
   * by=DRIVER (pre-recojo; el post-recojo emite trip.reassigning, no llega acá) → "tu conductor
   * canceló". by=SYSTEM → omitido (se cubre con trip.expired/failed). `by` entra al dedup: pasajero
   * y conductor pueden cancelar el mismo viaje en ramas distintas.
   */
  'trip.cancelled': defineSpec('trip.cancelled', {
    when: (p) => p.by !== 'SYSTEM',
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: (p) =>
      p.by === 'PASSENGER'
        ? TEMPLATE_KEYS.TRIP_CANCELLED_BY_PASSENGER
        : TEMPLATE_KEYS.TRIP_CANCELLED_BY_DRIVER,
    dedup: (p) => `trip:${p.tripId}:cancelled:${p.by}`,
    data: (p) => ({ tripId: p.tripId }),
  }),

  /**
   * trip.expired → push HONESTO: la puja no encontró conductor / venció la ventana. No hubo viaje
   * ⇒ payment NO cobra. "Degradación honesta": el pasajero SIEMPRE se entera.
   */
  'trip.expired': defineSpec('trip.expired', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_EXPIRED,
    dedup: (p) => `trip:${p.tripId}:expired`,
    data: (p) => ({ tripId: p.tripId }),
  }),

  /**
   * trip.failed → push HONESTO: el viaje no pudo completarse (cap de reasignación / abandono).
   * Se le confirma al pasajero que no se le cobró.
   */
  'trip.failed': defineSpec('trip.failed', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_FAILED,
    dedup: (p) => `trip:${p.tripId}:failed`,
    data: (p) => ({ tripId: p.tripId }),
  }),

  /**
   * S3 · trip.child_code_failed (BR-T07, modo niño) → push CRÍTICO al PASAJERO dueño de la cuenta
   * (padre/madre): posible impostor; el viaje NO inició. dedup por `eventId`: una redelivery del
   * MISMO intento no duplica, pero un intento NUEVO (otro evento) SÍ vuelve a alertar — es seguridad
   * infantil, cada intento cuenta. Sin passengerId enriquecido no hay destinatario (gate).
   */
  'trip.child_code_failed': defineSpec('trip.child_code_failed', {
    when: (p) => p.passengerId !== undefined,
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.TRIP_CHILD_CODE_FAILED,
    // SAFETY: seguridad infantil → drena ANTES que cualquier transaccional (misma prioridad que pánico).
    priority: NotificationPriority.Critical,
    dedup: (p, envelope) => `trip:${p.tripId}:child_code_failed:${envelope.eventId}`,
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.TripActive }),
  }),

  /** payment.captured → "pago confirmado · S/X.XX" (monto = grossCents). */
  'payment.captured': defineSpec('payment.captured', {
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.PAYMENT_CAPTURED,
    dedup: (p) => `payment:${p.paymentId}:captured`,
    vars: (p) => ({ amount: formatSoles(p.grossCents) }),
    data: (p) => ({ tripId: p.tripId, paymentId: p.paymentId }),
  }),

  /**
   * payment.cash_pending → push al PASAJERO: "confirma tu pago en efectivo de S/X". EFECTIVO
   * (decisión del dueño): el conductor ya confirmó "cobré" al terminar (driverConfirmed); falta SOLO
   * el pasajero para capturar. El conductor NO recibe push. Deep-link a la confirmación de efectivo.
   */
  'payment.cash_pending': defineSpec('payment.cash_pending', {
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.PAYMENT_CASH_PENDING,
    dedup: (p) => `payment:${p.paymentId}:cash_pending`,
    vars: (p) => ({ amount: formatSoles(p.grossCents) }),
    data: (p) => ({ tripId: p.tripId, paymentId: p.paymentId, screen: PUSH_SCREEN.CashConfirm }),
  }),

  /** payment.refunded → "te devolvimos S/X.XX" (monto = amountCents reembolsados). */
  'payment.refunded': defineSpec('payment.refunded', {
    recipient: (p) => p.passengerId,
    recipientFallback: (p) => p.tripId,
    template: TEMPLATE_KEYS.PAYMENT_REFUNDED,
    dedup: (p) => `payment:${p.paymentId}:refunded`,
    vars: (p) => ({ amount: formatSoles(p.amountCents) }),
    data: (p) => ({ tripId: p.tripId, paymentId: p.paymentId }),
  }),

  /**
   * payment.cancellation_penalty_recorded (F2) → push al PASAJERO: "penalidad de S/X por cancelar".
   * Deep-link al detalle de la penalidad para pagarla. (El collected, con DOS destinatarios, es
   * handler dedicado.)
   */
  'payment.cancellation_penalty_recorded': defineSpec('payment.cancellation_penalty_recorded', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.PAYMENT_PENALTY_RECORDED,
    dedup: (p) => `penalty:${p.penaltyId}:recorded`,
    vars: (p) => ({ amount: formatSoles(p.penaltyCents) }),
    data: (p) => ({
      tripId: p.tripId,
      penaltyId: p.penaltyId,
      screen: PUSH_SCREEN.CancellationPenalty,
    }),
  }),

  /**
   * payout.processed (ADR-015 §1 D7 · §4.1) → push al CONDUCTOR: "tu liquidación se procesó, S/X en camino a
   * tu billetera". `PROCESSED` confirmado = la plata SALIÓ del riel (semántica corregida del evento).
   *
   * BUG ARREGLADO (gate Lote 4 · D7): el evento targetea por `Driver.id` (el id propio del agregado del
   * conductor que viene de payments → trip/booking → driver-bff), NO por la cuenta `userId`. El device-token
   * store se consulta por `userId` → con `recipient: (p) => p.driverId` el lookup NO matchea jamás (Driver.id
   * ≠ userId, dos columnas UUID distintas) y el push se omitía SIEMPRE. Por eso `recipientKind: 'driverId'`:
   * el motor resuelve `driverId → userId` por gRPC a identity (GetDriver) ANTES del lookup de device-token.
   *
   * El monto NETO se formatea desde `amountCents` (es-PE: "S/" lo pone el template). SIN PII en el payload del
   * push (solo payoutId + deep-link a la billetera; NADA de driverId/userId/nombre). dedup
   * `payout:{payoutId}:processed`: un desembolso confirma UNA vez, redeliveries no duplican.
   */
  'payout.processed': defineSpec('payout.processed', {
    recipient: (p) => p.driverId,
    recipientKind: 'driverId',
    template: TEMPLATE_KEYS.PAYOUT_PROCESSED,
    dedup: (p) => `payout:${p.payoutId}:processed`,
    vars: (p) => ({ amount: formatSoles(p.amountCents) }),
    data: (p) => ({ payoutId: p.payoutId, screen: PUSH_SCREEN.Wallet }),
  }),

  /** payment.affiliation_activated → "Yape quedó vinculado". El destinatario (userId) viaja directo. */
  'payment.affiliation_activated': defineSpec('payment.affiliation_activated', {
    recipient: (p) => p.userId,
    template: TEMPLATE_KEYS.PAYMENT_AFFILIATION_ACTIVATED,
    dedup: (p) => `affiliation:${p.affiliationId}:activated`,
    data: () => ({ screen: PUSH_SCREEN.Wallet }),
  }),

  /** payment.affiliation_expired → "vuelve a vincular tu Yape". userId viaja directo. */
  'payment.affiliation_expired': defineSpec('payment.affiliation_expired', {
    recipient: (p) => p.userId,
    template: TEMPLATE_KEYS.PAYMENT_AFFILIATION_EXPIRED,
    dedup: (p) => `affiliation:${p.affiliationId}:expired`,
    data: () => ({ screen: PUSH_SCREEN.Wallet }),
  }),

  /**
   * chat.message_sent → push al DESTINATARIO. NO hay presencia (online/offline) en el sistema →
   * push SIEMPRE, dedup por messageId. Decisión MINIMAL: solo pushamos al PASAJERO cuando escribe
   * el conductor (senderRole=DRIVER) y el evento trae passengerId enriquecido; el caso inverso
   * (avisar al conductor) queda como decisión de producto pendiente.
   */
  'chat.message_sent': defineSpec('chat.message_sent', {
    when: (p) => p.senderRole === 'DRIVER' && p.passengerId !== undefined,
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.CHAT_MESSAGE,
    dedup: (p) => `chat:${p.messageId}`,
    vars: (p) => ({
      preview:
        p.body.length > CHAT_PREVIEW_MAX ? `${p.body.slice(0, CHAT_PREVIEW_SLICE)}...` : p.body,
    }),
    data: (p) => ({ tripId: p.tripId, screen: PUSH_SCREEN.Chat }),
  }),

  /**
   * SEGURIDAD · panic.acknowledged → push al PASAJERO: "la central vio tu alerta y está respondiendo".
   * Feedback tranquilizador en VIVO. Va SIEMPRE (no depende del desenmascarado familiar). passengerId
   * ENRIQUECIDO por panic-service desde la fila PanicEvent (siempre presente, no compat N-2). Priority
   * Critical: seguridad drena antes que cualquier transaccional. dedup `panic:{panicId}:ack`.
   * Deep-link al viaje activo (la víctima sigue viendo su viaje con normalidad para no delatar el pánico).
   */
  'panic.acknowledged': defineSpec('panic.acknowledged', {
    recipient: (p) => p.passengerId,
    template: TEMPLATE_KEYS.PANIC_ACKNOWLEDGED,
    priority: NotificationPriority.Critical,
    dedup: (p) => `panic:${p.panicId}:ack`,
    data: (p) => ({ tripId: p.tripId, panicId: p.panicId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * SEGURIDAD · panic.resolved → push al PASAJERO: "tu alerta fue cerrada". Va SIEMPRE en AMBOS status
   * (el pasajero recibe feedback del cierre tanto si fue RESOLVED como FALSE_ALARM — NO depende del
   * desenmascarado familiar). El COPY varía por status (template dinámico, ramificado por el enum
   * TIPADO `PanicStatus`, cero strings mágicos): FALSE_ALARM tiene tono distinto al cierre de emergencia.
   * passengerId ENRIQUECIDO por panic-service. Priority Critical. dedup `panic:{panicId}:resolved`.
   */
  'panic.resolved': defineSpec('panic.resolved', {
    recipient: (p) => p.passengerId,
    template: (p) =>
      p.status === PanicStatus.FALSE_ALARM
        ? TEMPLATE_KEYS.PANIC_RESOLVED_FALSE_ALARM
        : TEMPLATE_KEYS.PANIC_RESOLVED,
    priority: NotificationPriority.Critical,
    dedup: (p) => `panic:${p.panicId}:resolved`,
    data: (p) => ({ tripId: p.tripId, panicId: p.panicId, screen: PUSH_SCREEN.TripActive }),
  }),

  /**
   * fleet.vehicle_model_reviewed → push al CONDUCTOR (`requestedBy`) que pidió el modelo: el operador lo
   * aprobó o lo rechazó. El COPY varía por `verdict` (template dinámico, ramificado por el z.enum TIPADO
   * del contrato — cero strings mágicos de dominio). dedup `vehicle-model:{modelId}:reviewed`: un modelo
   * se resuelve UNA vez, redeliveries del mismo evento no duplican. No hay PUSH_SCREEN de flota → sin
   * deep-link; la app abre la bandeja general con `modelId`.
   */
  'fleet.vehicle_model_reviewed': defineSpec('fleet.vehicle_model_reviewed', {
    recipient: (p) => p.requestedBy,
    template: (p) =>
      p.verdict === 'APPROVED'
        ? TEMPLATE_KEYS.VEHICLE_MODEL_APPROVED
        : TEMPLATE_KEYS.VEHICLE_MODEL_REJECTED,
    dedup: (p) => `vehicle-model:${p.modelId}:reviewed`,
    vars: (p) => ({ make: p.make, model: p.model }),
    data: (p) => ({ modelId: p.modelId }),
  }),

  /**
   * driver.verified → push al CONDUCTOR: el operador aprobó sus antecedentes, ya puede operar (cierra el
   * loop del onboarding: sale de "En revisión"). recipient = userId (device-store). dedup
   * `driver:{driverId}:verified` (un alta se aprueba UNA vez; redeliveries no duplican). Sin PII: data solo
   * lleva driverId; la app abre su gate de registro (sin PUSH_SCREEN de onboarding todavía → sin deep-link).
   */
  'driver.verified': defineSpec('driver.verified', {
    recipient: (p) => p.userId,
    template: TEMPLATE_KEYS.DRIVER_APPROVED,
    dedup: (p) => `driver:${p.driverId}:verified`,
    data: (p) => ({ driverId: p.driverId }),
  }),

  /**
   * driver.rejected → push al CONDUCTOR: el operador rechazó sus antecedentes, debe corregir y reenviar.
   * El MOTIVO (p.reason) NO viaja en el push (es PII, §0.7) — la app lo resuelve en la pantalla de rechazo
   * vía GET /drivers/me. dedup `driver:{driverId}:rejected`. data solo driverId.
   */
  'driver.rejected': defineSpec('driver.rejected', {
    recipient: (p) => p.userId,
    template: TEMPLATE_KEYS.DRIVER_REJECTED,
    dedup: (p) => `driver:${p.driverId}:rejected`,
    data: (p) => ({ driverId: p.driverId }),
  }),

  /**
   * fleet.document_rejected → push al CONDUCTOR: el operador rechazó UNO de sus documentos, debe corregirlo y
   * reenviarlo. Cierra la ASIMETRÍA: antes solo el rechazo del ALTA (driver.rejected) avisaba; el rechazo
   * POR-DOCUMENTO era silencioso. Gate `when: ownerType==='DRIVER'` (un doc VEHICLE-scoped tiene vehicleId como
   * owner, no un conductor). `ownerId` es el Driver.id de PERFIL → `recipientKind:'driverId'` lo resuelve a
   * userId por gRPC a identity ANTES del lookup de device-token (igual que payout.processed). El MOTIVO NO viaja
   * en el push (PII §0.7): la app lo resuelve en la pantalla de rechazo vía GET /drivers/me/documents; el push
   * solo lleva documentType (categoría, no PII) para que la app resalte el doc. dedup por (documentId, rejectedAt):
   * una re-revisión posterior (re-subida → nuevo rechazo) SÍ vuelve a avisar; las redeliveries del mismo evento no.
   */
  'fleet.document_rejected': defineSpec('fleet.document_rejected', {
    when: (p) => p.ownerType === 'DRIVER',
    recipient: (p) => p.ownerId,
    recipientKind: 'driverId',
    template: TEMPLATE_KEYS.DOCUMENT_REJECTED,
    dedup: (p) => `document:${p.documentId}:rejected:${p.rejectedAt}`,
    data: (p) => ({ documentType: p.documentType }),
  }),
} satisfies { readonly [K in EventType]?: PushNotificationSpec<K> };

export type RegistryEventType = keyof typeof PUSH_NOTIFICATION_SPECS;

/* ────────────────────────────── el motor ────────────────────────────── */

/** Dependencias del motor (DI: el servicio cablea engine/devices/logger/identity; los tests, dobles). */
export interface PushSpecContext {
  /** Resolución de tokens con poison-guard (prioriza el hint del evento; si no, device-store). */
  resolveTargets(
    eventType: string,
    userId: string | undefined,
    token?: string,
    platform?: PushPlatform,
  ): Promise<DeviceTarget[]>;
  /**
   * Resuelve `Driver.id → userId` por gRPC a identity (solo para filas `recipientKind: 'driverId'`).
   * Devuelve `undefined` cuando identity RESPONDE que el driver no existe / sin userId (omito limpio).
   * LANZA ante fallo TRANSITORIO de transporte (gRPC caído/timeout) → el motor deja PROPAGAR el throw
   * para que Kafka redelivere el evento (simetría de durabilidad con el device-store), NO lo traga.
   */
  resolveUserIdFromDriver(driverId: string): Promise<string | undefined>;
  enqueue(input: EnqueueInput): Promise<unknown>;
  warn(message: string): void;
}

/**
 * Esqueleto común de TODAS las filas del registro:
 *   validar contrato (registro central) + enrichment → gate de producto → resolver destinos →
 *   warn-si-vacío → enqueue PUSH idempotente (`<dedup>:push:<token>`) por cada device.
 *
 * El payload inválido se descarta sin reintento (el wrapper Kafka ya validó el contrato del
 * registro antes de invocar el handler; acá protege llamadas directas y drift de enrichment).
 */
export async function runPushSpec(
  ctx: PushSpecContext,
  spec: PushNotificationSpec,
  envelope: EventEnvelope<unknown>,
): Promise<void> {
  const base = spec.schema.safeParse(envelope.payload);
  if (!base.success) return;
  const extra = spec.enrichment?.safeParse(envelope.payload);
  if (extra && !extra.success) return;
  const hint = pushTargetHintSchema.safeParse(envelope.payload);
  if (!hint.success) return;

  const payload: UnknownPayload = {
    ...(base.data as UnknownPayload),
    ...((extra?.data ?? {}) as UnknownPayload),
  };
  if (spec.when && !spec.when(payload)) return;

  const rawRecipient = spec.recipient(payload);
  const dedupSegment = spec.dedup(payload, envelope);

  // El device-token store SIEMPRE se consulta por `userId`. Si la fila targetea por `Driver.id`
  // (recipientKind: 'driverId'), resolvemos `driverId → userId` por gRPC a identity ANTES del lookup,
  // o el push NO matchearía jamás (ADR-015 D7). El `userId` resuelto es también el recipientId del
  // enqueue (la notificación se keya a la cuenta, no al Driver.id).
  //
  // SIMETRÍA DE DURABILIDAD: un fallo TRANSITORIO de identity (resolver LANZA) PROPAGA — Kafka redelivere
  // el evento (igual que el device-store transitorio), no se traga ⇒ la notificación de plata no se pierde
  // en un blip. Un RESULTADO permanente (resolver → undefined: driver inexistente/sin userId) se omite
  // limpio (reintentar no ayuda). El dedup del engine evita duplicar en el redelivery.
  let userId = rawRecipient;
  if (spec.recipientKind === 'driverId' && rawRecipient !== undefined) {
    userId = await ctx.resolveUserIdFromDriver(rawRecipient);
    if (!userId) {
      ctx.warn(
        `${spec.eventType} (${dedupSegment}): driver sin userId resoluble en identity → push omitido`,
      );
      return;
    }
  }

  const targets = await ctx.resolveTargets(
    spec.eventType,
    userId,
    hint.data.passengerPushToken,
    hint.data.platform,
  );
  if (targets.length === 0) {
    ctx.warn(
      `${spec.eventType} (${dedupSegment}): sin token push del destinatario (evento ni almacén) → push omitido`,
    );
    return;
  }

  const recipientId = userId ?? spec.recipientFallback?.(payload);
  if (!recipientId) {
    ctx.warn(`${spec.eventType} (${dedupSegment}): sin recipientId resoluble → push omitido`);
    return;
  }

  const template = typeof spec.template === 'function' ? spec.template(payload) : spec.template;
  for (const target of targets) {
    await ctx.enqueue({
      recipientId,
      channel: NotificationChannel.PUSH,
      template,
      ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
      dedupKey: `${dedupSegment}:push:${target.token}`,
      payload: {
        to: target.token,
        platform: target.platform,
        vars: spec.vars?.(payload) ?? {},
        data: spec.data(payload),
      },
    });
  }
}
