import type { PanicKey } from '@veo/api-client';
import { KeychainPanicSecretProvisioner } from '../src/features/panic/data/keychainPanicSecretProvisioner';
import type { PanicKeyRepository } from '../src/features/panic/domain/panicKeyRepository';
import { PanicKeyVersionMismatchError } from '../src/features/panic/domain/panicSecretProvisioner';
import type { PanicSecretStore } from '../src/features/panic/domain/panicSecretStore';
import { PANIC_SIGNATURE_VERSION } from '../src/features/panic/domain/panicSignature';

class FakeKeyRepository implements PanicKeyRepository {
  constructor(private readonly key: PanicKey) {}
  fetchKey = jest.fn(async (): Promise<PanicKey> => this.key);
}

class FakeSecretStore implements PanicSecretStore {
  constructor(private secret: string | null) {}
  getSecret = jest.fn(async () => this.secret);
  setSecret = jest.fn(async (s: string) => {
    this.secret = s;
  });
  clearSecret = jest.fn(async () => {
    this.secret = null;
  });
}

describe('KeychainPanicSecretProvisioner', () => {
  const validKey: PanicKey = { secret: 'shared-hmac-secret', version: PANIC_SIGNATURE_VERSION };

  it('ensureProvisioned descarga y persiste el secreto cuando no existe', async () => {
    const keyRepo = new FakeKeyRepository(validKey);
    const store = new FakeSecretStore(null);
    const provisioner = new KeychainPanicSecretProvisioner(keyRepo, store);

    await provisioner.ensureProvisioned();

    expect(keyRepo.fetchKey).toHaveBeenCalledTimes(1);
    expect(store.setSecret).toHaveBeenCalledWith('shared-hmac-secret');
  });

  it('ensureProvisioned es no-op cuando el secreto ya está provisionado', async () => {
    const keyRepo = new FakeKeyRepository(validKey);
    const store = new FakeSecretStore('ya-existe');
    const provisioner = new KeychainPanicSecretProvisioner(keyRepo, store);

    await provisioner.ensureProvisioned();

    expect(keyRepo.fetchKey).not.toHaveBeenCalled();
    expect(store.setSecret).not.toHaveBeenCalled();
  });

  it('refresh siempre vuelve a descargar y persiste (rotación)', async () => {
    const keyRepo = new FakeKeyRepository(validKey);
    const store = new FakeSecretStore('clave-vieja');
    const provisioner = new KeychainPanicSecretProvisioner(keyRepo, store);

    await provisioner.refresh();

    expect(keyRepo.fetchKey).toHaveBeenCalledTimes(1);
    expect(store.setSecret).toHaveBeenCalledWith('shared-hmac-secret');
  });

  it('falla en alto si la versión del mensaje canónico no coincide (no firma mal)', async () => {
    const keyRepo = new FakeKeyRepository({ secret: 's', version: 'panic.trigger:v2' });
    const store = new FakeSecretStore(null);
    const provisioner = new KeychainPanicSecretProvisioner(keyRepo, store);

    await expect(provisioner.refresh()).rejects.toBeInstanceOf(PanicKeyVersionMismatchError);
    expect(store.setSecret).not.toHaveBeenCalled();
  });
});
