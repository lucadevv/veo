/**
 * Entidades del CENTRO DE AVISOS del pasajero (Notifs del design-handoff).
 *
 * El backend de listado de avisos NO existe todavía: el `public-bff` solo expone el registro del
 * token de push (POST /notifications/device-token). Por eso el modelo del dominio queda definido
 * (para que la pantalla y el repositorio sean reales y enchufables cuando el endpoint llegue), pero
 * la implementación actual devuelve una lista VACÍA honesta — nunca avisos inventados.
 */

/** Categoría del aviso (mapea a un ícono/tono y, opcionalmente, a una acción de navegación). */
export type NotificationKind = 'TRIP' | 'SAFETY' | 'PROMO' | 'RECEIPT' | 'GENERAL';

/** Un aviso del centro de notificaciones. */
export interface AppNotification {
  /** Identificador estable del aviso. */
  id: string;
  /** Categoría: define ícono y tono. */
  kind: NotificationKind;
  /** Título corto. */
  title: string;
  /** Cuerpo descriptivo. */
  body: string;
  /** Marca temporal ISO-8601 de emisión. */
  createdAt: string;
  /** `true` si el pasajero ya lo abrió/leyó. */
  read: boolean;
}
