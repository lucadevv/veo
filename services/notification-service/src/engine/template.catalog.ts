/**
 * Catálogo de plantillas i18n por defecto (Lima/Perú, es-PE). Sirven al seed y a los consumidores.
 * Body con placeholders {{var}} interpolados por TemplateService.
 */
import { NotificationChannel } from '@veo/shared-types';

export const TEMPLATE_KEYS = {
  PANIC_CONTACT_ALERT: 'panic.contact_alert',
  PANIC_CENTRAL_ALERT: 'panic.central_alert',
  PANIC_ACKNOWLEDGED: 'panic.acknowledged',
  PANIC_RESOLVED: 'panic.resolved',
  PANIC_RESOLVED_FALSE_ALARM: 'panic.resolved_false_alarm',
  TRIP_ASSIGNED: 'trip.assigned',
  TRIP_ACCEPTED: 'trip.accepted',
  TRIP_STARTED: 'trip.started',
  TRIP_DESTINATION_CHANGED: 'trip.destination_changed',
  TRIP_ARRIVING: 'trip.arriving',
  TRIP_ARRIVED: 'trip.arrived',
  TRIP_ARRIVED_WAIT: 'trip.arrived_wait',
  TRIP_SCHEDULED_READY: 'trip.scheduled_ready',
  TRIP_REASSIGNING: 'trip.reassigning',
  TRIP_COMPLETED: 'trip.completed',
  TRIP_CANCELLED_BY_PASSENGER: 'trip.cancelled_by_passenger',
  TRIP_CANCELLED_BY_DRIVER: 'trip.cancelled_by_driver',
  TRIP_EXPIRED: 'trip.expired',
  TRIP_FAILED: 'trip.failed',
  TRIP_CHILD_CODE_FAILED: 'trip.child_code_failed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_CASH_PENDING: 'payment.cash_pending',
  PAYMENT_REFUNDED: 'payment.refunded',
  PAYMENT_AFFILIATION_ACTIVATED: 'payment.affiliation_activated',
  PAYMENT_AFFILIATION_EXPIRED: 'payment.affiliation_expired',
  PAYMENT_PENALTY_RECORDED: 'payment.penalty_recorded',
  PAYMENT_PENALTY_COLLECTED: 'payment.penalty_collected',
  PAYMENT_PENALTY_DRIVER_COMP: 'payment.penalty_driver_comp',
  PAYOUT_PROCESSED: 'payout.processed',
  PAYOUT_FAILED_CENTRAL_ALERT: 'payout.failed_central_alert',
  PAYMENT_CENTRAL_ALERT: 'payment.central_alert',
  CHAT_MESSAGE: 'chat.message',
  CONTACT_OTP: 'contact.otp',
  VEHICLE_MODEL_APPROVED: 'fleet.vehicle_model_approved',
  VEHICLE_MODEL_REJECTED: 'fleet.vehicle_model_rejected',
  DRIVER_APPROVED: 'driver.approved',
  DRIVER_REJECTED: 'driver.rejected',
} as const;

/** Key TIPADA del catálogo: referenciar un template inexistente no compila. */
export type TemplateKey = (typeof TEMPLATE_KEYS)[keyof typeof TEMPLATE_KEYS];

export interface TemplateSeed {
  key: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
}

/**
 * Categoría de BANDEJA (define ícono/tono en la app). Es semántica PÚBLICA y estable: las keys
 * internas de plantilla (`trip.accepted`, etc.) NO se filtran al cliente — solo su categoría.
 */
export type InboxCategory = 'trip' | 'safety' | 'payment' | 'promo' | 'general';

/** Deriva la categoría de bandeja a partir de la FAMILIA de la key (prefijo), no de la key exacta. */
export function categoryForTemplate(key: string): InboxCategory {
  if (key.startsWith('trip.') || key.startsWith('chat.')) return 'trip';
  if (key.startsWith('panic.') || key.startsWith('contact.')) return 'safety';
  if (key.startsWith('payment.') || key.startsWith('payout.')) return 'payment';
  if (key.startsWith('promo.')) return 'promo';
  return 'general';
}

const LOCALE = 'es-PE';

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    key: TEMPLATE_KEYS.PANIC_CONTACT_ALERT,
    channel: NotificationChannel.SMS,
    locale: LOCALE,
    subject: null,
    body:
      'ALERTA VEO: {{name}}, una persona que confia en ti activo el boton de panico. ' +
      'Ubicacion: {{lat}},{{lon}}. Sigue su viaje en vivo: {{shareLink}}',
  },
  {
    key: TEMPLATE_KEYS.PANIC_CENTRAL_ALERT,
    channel: NotificationChannel.WEBHOOK,
    locale: LOCALE,
    subject: null,
    body: 'PANICO panic={{panicId}} viaje={{tripId}} pasajero={{passengerId}}',
  },
  {
    // Push al PASAJERO cuando la central RECONOCE su alerta. Feedback tranquilizador SIN PII (el cuerpo
    // se resuelve en cliente; el push lleva solo IDs/deep-link, §0.7).
    key: TEMPLATE_KEYS.PANIC_ACKNOWLEDGED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'La central vio tu alerta',
    body: 'La central de seguridad VEO vio tu alerta y esta respondiendo. Mantente seguro.',
  },
  {
    // Push al PASAJERO cuando la central CIERRA la alerta como emergencia atendida (RESOLVED).
    key: TEMPLATE_KEYS.PANIC_RESOLVED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu alerta fue cerrada',
    body: 'La central de seguridad VEO cerro tu alerta. Si necesitas ayuda otra vez, vuelve a activarla.',
  },
  {
    // Variante de copy cuando el cierre fue FALSA ALARMA: tono distinto (sin "emergencia").
    key: TEMPLATE_KEYS.PANIC_RESOLVED_FALSE_ALARM,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu alerta fue cerrada',
    body: 'Tu alerta se cerro como falsa alarma. Tu viaje continua normal. Gracias por cuidarte.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_ASSIGNED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Conductor asignado',
    body: '{{driverName}} va en camino ({{vehiclePlate}}). Llega en {{etaMinutes}} min.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_ACCEPTED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor confirmo',
    body: '{{driverName}} confirmo tu viaje y va en camino. Llega en {{etaMinutes}} min.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_STARTED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu viaje empezo',
    body: 'Tu viaje empezo. Comparte tu trayecto en vivo con tu familia desde la app.',
  },
  {
    // RC5 · alerta de seguridad del menor: el destino de un viaje en modo nino cambio. Va al guardian (dueno
    // de la cuenta) para que confirme o reaccione ante una posible redireccion del nino.
    key: TEMPLATE_KEYS.TRIP_DESTINATION_CHANGED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Cambio de destino del viaje',
    body: 'El destino del viaje en modo nino cambio. Si no fuiste tu, abre la app y revisa el viaje ahora.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_ARRIVING,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor esta llegando',
    body: '{{driverName}} esta llegando al punto de recojo. Preparate para abordar.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_ARRIVED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor llego',
    body: '{{driverName}} llego al punto de recojo y te esta esperando.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_ARRIVED_WAIT,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor llego',
    body: '{{driverName}} llego y te espera. Tienes {{waitMinutes}} min antes de que aplique espera.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_SCHEDULED_READY,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu viaje programado empezo',
    body: 'Los conductores ya estan ofertando. Entra y elige tu conductor.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_REASSIGNING,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor cancelo',
    body: 'Reabrimos la busqueda. Entra y elegi un nuevo conductor.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_COMPLETED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Viaje completado',
    body: 'Gracias por viajar con VEO. Revisa el detalle de tu viaje.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_CANCELLED_BY_PASSENGER,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Cancelaste tu viaje',
    body: 'Cancelaste tu viaje. Si fue un error, puedes pedir otro cuando quieras.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_CANCELLED_BY_DRIVER,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu conductor cancelo',
    body: 'Tu conductor cancelo el viaje. Pide otro y te buscamos un nuevo conductor.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_EXPIRED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'No encontramos conductor',
    body: 'No encontramos un conductor disponible. Puedes volver a pedir o subir tu oferta.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_FAILED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu viaje no pudo completarse',
    body: 'Tu viaje no pudo completarse. No se te cobro.',
  },
  {
    key: TEMPLATE_KEYS.TRIP_CHILD_CODE_FAILED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Alerta de seguridad',
    body:
      'Alguien intento iniciar el viaje de tu hijo con un codigo incorrecto. ' +
      'El viaje NO inicio. Revisa el viaje ahora.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_FAILED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Problema con tu pago',
    body: 'No pudimos procesar tu pago: {{reason}}. Lo intentaremos nuevamente.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_CAPTURED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Pago confirmado',
    body: 'Pago confirmado · S/{{amount}}. Gracias por viajar con VEO.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_REFUNDED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Te devolvimos tu pago',
    body: 'Te devolvimos S/{{amount}}. El reembolso puede tardar unos dias en reflejarse.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_CASH_PENDING,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Confirma tu pago en efectivo',
    body: 'Confirma tu pago en efectivo de S/{{amount}} para cerrar tu viaje. Toca aqui para confirmar.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_AFFILIATION_ACTIVATED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Yape quedo vinculado',
    body: 'Yape quedo vinculado · tus viajes se cobran solos, sin abrir la app de Yape.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_AFFILIATION_EXPIRED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Vuelve a vincular tu Yape',
    body: 'Tu Yape se desvinculo. Vuelve a vincularlo para que tus viajes se cobren solos.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_PENALTY_RECORDED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Penalidad por cancelacion',
    body: 'Se aplico una penalidad de S/{{amount}} por cancelar tu viaje. Pagala para pedir tu proximo viaje.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_PENALTY_COLLECTED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Penalidad pagada',
    body: 'Pagaste tu penalidad de S/{{amount}}. Ya puedes volver a pedir viajes.',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_PENALTY_DRIVER_COMP,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Compensacion por espera',
    body: 'Recibiste S/{{amount}} por la cancelacion de un pasajero. Se suma a tu liquidacion.',
  },
  {
    key: TEMPLATE_KEYS.CHAT_MESSAGE,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Nuevo mensaje de tu conductor',
    body: 'Tu conductor te escribio: {{preview}}',
  },
  {
    // Push al CONDUCTOR cuando su liquidación se DESEMBOLSÓ de verdad (ADR-015 D7: PROCESSED confirmado =
    // la plata salió). Monto NETO en soles desde amountCents. Sin PII en el payload del evento (§0.7); el
    // copy lo compone notification-service. La app abre su billetera (deep-link Wallet).
    key: TEMPLATE_KEYS.PAYOUT_PROCESSED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Tu liquidacion se proceso',
    body: 'Tu liquidacion se proceso · S/{{amount}} en camino a tu billetera.',
  },
  {
    // Aviso al OPERADOR/central (ADR-015 D7 opcional) cuando el desembolso FALLA (PROCESSING → FAILED): la
    // plata NO salió, el operador puede reintentar. Reusa el riel webhook a la central (CENTRAL_ALERT_WEBHOOK_URL),
    // mismo carril que PAYMENT_CENTRAL_ALERT — NO es un canal nuevo. Sin PII: solo IDs + monto + período.
    key: TEMPLATE_KEYS.PAYOUT_FAILED_CENTRAL_ALERT,
    channel: NotificationChannel.WEBHOOK,
    locale: LOCALE,
    subject: null,
    body: 'PAYOUT_FALLIDO payout={{payoutId}} conductor={{driverId}} periodo={{period}}',
  },
  {
    key: TEMPLATE_KEYS.PAYMENT_CENTRAL_ALERT,
    channel: NotificationChannel.WEBHOOK,
    locale: LOCALE,
    subject: null,
    body: 'PAGO_FALLIDO pago={{paymentId}} viaje={{tripId}} motivo={{reason}}',
  },
  {
    key: TEMPLATE_KEYS.CONTACT_OTP,
    channel: NotificationChannel.SMS,
    locale: LOCALE,
    subject: null,
    body: 'Tu codigo VEO para verificar tu contacto de confianza es {{code}}. Valido 5 minutos. No lo compartas.',
  },
  {
    // Push al CONDUCTOR cuando el operador APRUEBA el modelo que solicitó: ya puede operar con él.
    key: TEMPLATE_KEYS.VEHICLE_MODEL_APPROVED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Modelo aprobado',
    body: 'Tu {{make}} {{model}} ya esta habilitado para trabajar.',
  },
  {
    // Push al CONDUCTOR cuando el operador RECHAZA el modelo que solicitó.
    key: TEMPLATE_KEYS.VEHICLE_MODEL_REJECTED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Modelo rechazado',
    body: 'Tu solicitud de {{make}} {{model}} no fue aprobada. Contacta a soporte.',
  },
  {
    // Push al CONDUCTOR cuando el operador APRUEBA sus antecedentes: ya puede operar (cierra el loop, el
    // conductor sale de "En revisión"). Sin PII en el payload (§0.7); la app abre su gate de registro.
    key: TEMPLATE_KEYS.DRIVER_APPROVED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: '¡Ya puedes manejar!',
    body: 'Tu cuenta de conductor fue aprobada. Abre VEO y empieza tu primer turno.',
  },
  {
    // Push al CONDUCTOR cuando el operador RECHAZA sus antecedentes: debe corregir y reenviar. El MOTIVO
    // NO viaja en el push (es PII) — la app lo resuelve en la pantalla de rechazo vía GET /drivers/me.
    key: TEMPLATE_KEYS.DRIVER_REJECTED,
    channel: NotificationChannel.PUSH,
    locale: LOCALE,
    subject: 'Revisá tu solicitud',
    body: 'Tu solicitud de conductor necesita correcciones. Abre VEO para ver el motivo y reenviar.',
  },
];
