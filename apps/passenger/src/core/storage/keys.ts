/**
 * Claves de almacenamiento (MMKV). Centralizadas para evitar literales repetidos y colisiones.
 */

/**
 * IDs de las instancias MMKV. Cada `id` mapea a un archivo distinto en disco; centralizarlos evita
 * literales repetidos y el riesgo de abrir dos veces la misma instancia con configuraciones divergentes
 * (p. ej. la de arranque vs la del Keychain, que fue la raíz del borrado de sesión en cada cold-start).
 *
 * Los VALORES conservan los ids históricos del pasajero (`veo.secure` / `veo.prefs`): cambiarlos
 * huérfanaría los archivos ya escritos en disco de instalaciones existentes.
 */
export const StoreId = {
  /** Almacén CIFRADO (tokens/sesión): se abre con la clave del Keychain/Keystore + AES-256. */
  Secure: 'veo.secure',
  /** Almacén de PREFERENCIAS (no sensibles): sin cifrado. */
  Prefs: 'veo.prefs',
} as const;

export type StoreIdName = (typeof StoreId)[keyof typeof StoreId];
