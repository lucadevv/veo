import {hmacSha256Hex} from '../../../shared/crypto/hmacSha256';
import {
  type PanicSecretStore,
  PanicSecretUnavailableError,
} from '../domain/panicSecretStore';
import {buildPanicSignatureMessage} from '../domain/panicSignature';
import type {PanicSignaturePayload, PanicSigner} from '../domain/panicSigner';

/**
 * Firmador REAL del pánico (BR-S04): produce `HMAC_SHA256(mensaje_canónico, secreto)` en hex.
 *
 * El secreto lo provisiona el backend al device (Keychain/Keystore vía `PanicSecretStore`). Si aún
 * no está provisionado, lanza `PanicSecretUnavailableError` en lugar de firmar con un secreto
 * inventado (que el backend rechazaría). DIP: depende de la abstracción `PanicSecretStore`.
 */
export class KeychainPanicSigner implements PanicSigner {
  constructor(private readonly secretStore: PanicSecretStore) {}

  async sign(payload: PanicSignaturePayload): Promise<string> {
    const secret = await this.secretStore.getSecret();
    if (!secret) {
      throw new PanicSecretUnavailableError();
    }
    const message = buildPanicSignatureMessage(payload);
    return hmacSha256Hex(message, secret);
  }
}
