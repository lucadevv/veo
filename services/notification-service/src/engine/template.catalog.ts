/**
 * Catálogo de plantillas i18n por defecto (Lima/Perú, es-PE). Sirven al seed y a los consumidores.
 * Body con placeholders {{var}} interpolados por TemplateService.
 */
import { NotificationChannel } from '@veo/shared-types';

export const TEMPLATE_KEYS = {
  PANIC_CONTACT_ALERT: 'panic.contact_alert',
  PANIC_CENTRAL_ALERT: 'panic.central_alert',
  TRIP_ASSIGNED: 'trip.assigned',
  TRIP_ACCEPTED: 'trip.accepted',
  TRIP_STARTED: 'trip.started',
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
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_CASH_PENDING: 'payment.cash_pending',
  PAYMENT_REFUNDED: 'payment.refunded',
  PAYMENT_AFFILIATION_ACTIVATED: 'payment.affiliation_activated',
  PAYMENT_AFFILIATION_EXPIRED: 'payment.affiliation_expired',
  PAYMENT_PENALTY_RECORDED: 'payment.penalty_recorded',
  PAYMENT_PENALTY_COLLECTED: 'payment.penalty_collected',
  PAYMENT_PENALTY_DRIVER_COMP: 'payment.penalty_driver_comp',
  PAYMENT_CENTRAL_ALERT: 'payment.central_alert',
  CHAT_MESSAGE: 'chat.message',
  CONTACT_OTP: 'contact.otp',
} as const;

export interface TemplateSeed {
  key: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
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
];
