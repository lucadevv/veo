import {create} from 'zustand';
import {prefsStore} from '../../../../core/storage/mmkv';

/**
 * Preferencias de notificaciones del pasajero (design/veo.pen P/NotifPrefs) — Zustand + cache MMKV,
 * offline-first.
 *
 * FUENTE DE VERDAD: el backend (notification-service, `GET/PUT /notification-prefs`). Al montar la
 * pantalla, se HIDRATA el store desde el server (`hydrate`); al togglear una preferencia, `setPref`
 * actualiza MMKV (instantáneo, offline) Y empuja el objeto COMPLETO al backend best-effort
 * (`backendSync`, cableado en el composition root). MMKV es el cache que sirve la UI al instante y
 * sobrevive sin red; el backend lo hace sobrevivir reinstalación/multi-dispositivo. Mismo patrón que
 * `paymentPrefsStore`.
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
  /** Cambia UNA preferencia: actualiza estado + MMKV en el acto y empuja el objeto completo al backend. */
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
  /** Hidrata desde el backend SIN re-empujar (el valor YA viene del server: evita el echo). */
  hydrate: (prefs: NotificationPrefs) => void;
}

/** Carga desde MMKV mezclando con los defaults: tolera claves nuevas agregadas en updates. */
function loadPrefs(): NotificationPrefs {
  const stored = prefsStore.getJSON<Partial<NotificationPrefs>>(KEY);
  return {...DEFAULT_NOTIFICATION_PREFS, ...stored};
}

/**
 * Sincronizador al backend, INYECTADO desde el composition root (registry). El store NO depende de la
 * DI ni de HTTP (DIP): el root le pasa CÓMO persistir el objeto completo (PUT /notification-prefs).
 * `null` hasta cablearse → sin él `setPref` solo persiste local (degradación honesta; en tests no
 * dispara red, y si el lead aún no cableó el binding no crashea, solo no sincroniza).
 */
let backendSync: ((prefs: NotificationPrefs) => void) | null = null;
export function setNotificationPrefsBackendSync(
  fn: (prefs: NotificationPrefs) => void,
): void {
  backendSync = fn;
}

export const useNotificationPrefsStore = create<NotificationPrefsState>(
  set => ({
    prefs: loadPrefs(),
    setPref: (key, value) =>
      set(state => {
        const prefs = {...state.prefs, [key]: value};
        prefsStore.setJSON(KEY, prefs);
        // PUT reemplaza el objeto completo: empujamos TODAS las prefs, no solo la que cambió.
        backendSync?.(prefs);
        return {prefs};
      }),
    hydrate: prefs =>
      set(() => {
        prefsStore.setJSON(KEY, prefs);
        return {prefs};
      }),
  }),
);
