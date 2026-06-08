/**
 * Puerto de almacenamiento del SECRETO HMAC del pánico (DIP).
 *
 * El secreto lo provisiona el backend al device (Keychain/Keystore). NO se invent­a en el cliente.
 * La implementación concreta (`KeychainPanicSecretStore`) usa el almacén seguro del SO.
 *
 * IMPORTANTE: el secreto NO debe quedar protegido por biometría, porque el pánico debe poder
 * firmarse sin interacción del usuario (incluso bajo coacción / pantalla bloqueada).
 */
export interface PanicSecretStore {
  /** Devuelve el secreto HMAC provisionado, o null si aún no se ha entregado. */
  getSecret(): Promise<string | null>;
  /** Persiste el secreto HMAC entregado por el backend. */
  setSecret(secret: string): Promise<void>;
  /** Elimina el secreto (p. ej. al cerrar sesión). */
  clearSecret(): Promise<void>;
}

/**
 * Error de dominio cuando el secreto HMAC del pánico aún no está provisionado en el device.
 * NO es un mock: evita firmar con un secreto inventado (el backend lo rechazaría).
 */
export class PanicSecretUnavailableError extends Error {
  constructor() {
    super(
      '[veo] secreto HMAC de pánico no provisionado en el device (falta entrega del backend, BR-S04)',
    );
    this.name = 'PanicSecretUnavailableError';
  }
}
