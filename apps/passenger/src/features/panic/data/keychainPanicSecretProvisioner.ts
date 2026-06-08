import type { PanicKeyRepository } from '../domain/panicKeyRepository';
import type { PanicSecretStore } from '../domain/panicSecretStore';
import {
  PanicKeyVersionMismatchError,
  type PanicSecretProvisioner,
} from '../domain/panicSecretProvisioner';
import { PANIC_SIGNATURE_VERSION } from '../domain/panicSignature';

/**
 * Aprovisionador REAL del secreto HMAC de pánico.
 *
 * Compone (DIP): descarga la clave del backend (`PanicKeyRepository`) y la persiste en el almacén
 * seguro sin biometría (`PanicSecretStore`). Verifica que la versión del mensaje canónico coincida
 * con la que el cliente sabe firmar; si difiere, falla en alto (nunca firma con un formato erróneo).
 */
export class KeychainPanicSecretProvisioner implements PanicSecretProvisioner {
  constructor(
    private readonly keyRepository: PanicKeyRepository,
    private readonly secretStore: PanicSecretStore,
  ) {}

  async ensureProvisioned(): Promise<void> {
    const existing = await this.secretStore.getSecret();
    if (existing) {
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const key = await this.keyRepository.fetchKey();
    if (key.version !== PANIC_SIGNATURE_VERSION) {
      throw new PanicKeyVersionMismatchError(PANIC_SIGNATURE_VERSION, key.version);
    }
    await this.secretStore.setSecret(key.secret);
  }
}
