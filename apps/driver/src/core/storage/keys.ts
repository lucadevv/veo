/**
 * Claves de almacenamiento (MMKV). Centralizadas para evitar literales repetidos y colisiones.
 */

/**
 * IDs de las instancias MMKV. Cada `id` mapea a un archivo distinto en disco; centralizarlos evita
 * literales repetidos y el riesgo de abrir dos veces la misma instancia con configuraciones divergentes
 * (p. ej. la de arranque vs la del Keystore, que fue la raíz del borrado de sesión en cada cold-start).
 */
export const StoreId = {
  /** Almacén CIFRADO (tokens/sesión): se abre con la clave del Keystore + AES-256. */
  Secure: 'veo.driver.secure',
  /** Almacén de PREFERENCIAS (no sensibles): sin cifrado. */
  Prefs: 'veo.driver.prefs',
} as const;

export type StoreIdName = (typeof StoreId)[keyof typeof StoreId];

/** Claves del almacén CIFRADO (datos sensibles: tokens y sesión). */
export const SecureKey = {
  AccessToken: 'auth.accessToken',
  RefreshToken: 'auth.refreshToken',
  SessionUser: 'auth.sessionUser',
} as const;

/** Claves del almacén de PREFERENCIAS (no sensibles). */
export const PrefKey = {
  Language: 'pref.language',
  LastShiftStatus: 'pref.lastShiftStatus',
  /** Tipo de vehículo activo declarado por el conductor (CAR | MOTO). */
  VehicleType: 'pref.vehicleType',
  /**
   * Marca de tiempo (epoch ms, string) del inicio del turno EN CURSO. La escribe el cliente al abrir
   * turno y la consume el resumen de cierre para calcular la duración ("en la calle hoy"): el backend
   * NO expone `startedAt` en el estado de turno, así que el reloj es local (degrada honesto si falta).
   */
  ShiftStartedAt: 'pref.shiftStartedAt',
} as const;

export type SecureKeyName = (typeof SecureKey)[keyof typeof SecureKey];
export type PrefKeyName = (typeof PrefKey)[keyof typeof PrefKey];
