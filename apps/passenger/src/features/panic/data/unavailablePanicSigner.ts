import {NotImplementedError} from '../../../core/errors/notImplemented';
import type {PanicSignaturePayload, PanicSigner} from '../domain/panicSigner';

/**
 * Firma de pánico por defecto mientras no exista el módulo nativo. NO es un mock: nunca devuelve
 * una firma falsa (el bff la rechazaría). Falla explícitamente para que la UI degrade. La OLEADA
 * NATIVA reemplaza este binding por el firmador HMAC real.
 */
export class UnavailablePanicSigner implements PanicSigner {
  sign(_payload: PanicSignaturePayload): Promise<string> {
    return Promise.reject(new NotImplementedError('panic.sign'));
  }
}
