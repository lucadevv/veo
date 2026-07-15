/**
 * Entidades de la BANDEJA de avisos del CONDUCTOR (feed in-app). Espejo del dominio del pasajero
 * (`apps/passenger/.../notifications/domain/entities.ts`): mismo modelo, misma semántica, para que la
 * pantalla y el repositorio sean reales y enchufables.
 *
 * Hasta hoy el conductor solo tenía PUSH/FCM (ver `presentation/PushManager`). Esta bandeja cierra el
 * seam: el `driver-bff` ya expone `GET /notifications` pero ninguna pantalla lo consumía.
 */

/** Categoría del aviso: define ícono y tono en la fila del feed (y, a futuro, una acción de navegación). */
export type NotificationKind = 'TRIP' | 'SAFETY' | 'PROMO' | 'RECEIPT' | 'GENERAL';

/** Un aviso del centro de notificaciones del conductor. */
export interface AppNotification {
  /** Identificador estable del aviso. */
  id: string;
  /** Categoría: define ícono y tono. */
  kind: NotificationKind;
  /** Título corto. */
  title: string;
  /** Cuerpo descriptivo. */
  body: string;
  /** Marca temporal ISO-8601 de emisión (orden DESC por este campo). */
  createdAt: string;
  /** `true` si el conductor ya lo abrió/leyó. */
  read: boolean;
}
