import type {AppNotification} from './entities';

/**
 * Puerto del centro de avisos (DIP). El listado de avisos NO tiene endpoint en el `public-bff`
 * todavía; este contrato existe para que la presentación dependa de la ABSTRACCIÓN y la
 * implementación concreta (hoy un feed vacío honesto; mañana una impl HTTP) sea sustituible bajo
 * el mismo token de DI sin tocar dominio ni UI.
 */
export interface NotificationsRepository {
  /** Lista los avisos del pasajero, más recientes primero. */
  list(): Promise<AppNotification[]>;
}
