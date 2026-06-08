/**
 * Claves de almacenamiento (MMKV). Centralizadas para evitar literales repetidos y colisiones.
 */

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
} as const;

export type SecureKeyName = (typeof SecureKey)[keyof typeof SecureKey];
export type PrefKeyName = (typeof PrefKey)[keyof typeof PrefKey];
