/**
 * Puerto de APROVISIONAMIENTO del secreto HMAC de pánico (DIP).
 *
 * Orquesta la descarga del secreto del backend (`PanicKeyRepository`) y su persistencia en el
 * almacén seguro (`PanicSecretStore`). Se invoca de forma EAGER tras el login y de forma PEREZOSA
 * la primera vez que se dispara el pánico; además permite ROTAR el secreto si el backend lo cambia.
 */
export interface PanicSecretProvisioner {
  /** Descarga y persiste el secreto SOLO si aún no está en el device (idempotente, perezoso). */
  ensureProvisioned(): Promise<void>;
  /** Fuerza una nueva descarga del secreto y lo persiste (rotación de clave). */
  refresh(): Promise<void>;
}

/**
 * Error de versión del mensaje canónico: el backend emitió una versión de firma distinta a la que
 * el cliente sabe construir. Falla en alto (en vez de firmar mal) para no enviar firmas inválidas.
 */
export class PanicKeyVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      `[veo] versión de la clave de pánico incompatible: cliente "${expected}" vs backend "${received}"`,
    );
    this.name = 'PanicKeyVersionMismatchError';
  }
}
