import {create} from 'zustand';
import {prefsStore} from '../../../../core/storage/mmkv';

/**
 * Preferencias de notificaciones del pasajero (design/veo.pen P/NotifPrefs) — Zustand + MMKV.
 *
 * GAP DE BACKEND (reportado): no existe endpoint de preferencias de notificaciones en el
 * public-bff/notification-service, así que la persistencia es SOLO LOCAL (`prefsStore`, el mismo
 * MMKV de preferencias que usa `paymentPrefsStore`). La pantalla lo dice honesto ("se guardan en
 * este teléfono"). Cuando exista el backend, este store adopta el patrón hydrate/backendSync de
 * `paymentPrefsStore` sin cambiar la UI.
 *
 * Las alertas de SEGURIDAD (pánico / verificación biométrica) NO viven acá a propósito: son
 * NO desactivables por diseño del producto (seguridad no negociable) — la UI las muestra
 * encendidas y deshabilitadas, sin estado que persistir.
 */
const KEY = 'notifications.prefs';

export interface NotificationPrefs {
  /** Viajes · cuando tu conductor confirma o cancela. */
  tripStatus: boolean;
  /** Viajes · avisos de llegada y demoras del conductor. */
  driverEnRoute: boolean;
  /** Viajes · recordatorios de viajes programados. */
  scheduledReminders: boolean;
  /** Promociones · ofertas y cupones. */
  offers: boolean;
  /** Promociones · novedades de VEO. */
  news: boolean;
}

/** Defaults per pen o73nx: los de viaje encendidos; los promocionales apagados (opt-in). */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  tripStatus: true,
  driverEnRoute: true,
  scheduledReminders: true,
  offers: false,
  news: false,
};

interface NotificationPrefsState {
  prefs: NotificationPrefs;
  /** Cambia UNA preferencia: actualiza el estado y persiste en MMKV en el acto. */
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
}

/** Carga desde MMKV mezclando con los defaults: tolera claves nuevas agregadas en updates. */
function loadPrefs(): NotificationPrefs {
  const stored = prefsStore.getJSON<Partial<NotificationPrefs>>(KEY);
  return {...DEFAULT_NOTIFICATION_PREFS, ...stored};
}

export const useNotificationPrefsStore = create<NotificationPrefsState>(
  set => ({
    prefs: loadPrefs(),
    setPref: (key, value) =>
      set(state => {
        const prefs = {...state.prefs, [key]: value};
        prefsStore.setJSON(KEY, prefs);
        return {prefs};
      }),
  }),
);
