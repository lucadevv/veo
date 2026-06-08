import * as Keychain from 'react-native-keychain';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  initSecureStorage,
} from '../secure-encryption-key';

/**
 * Override local del mock de `react-native-keychain`: el mock global (jest.setup.js) no expone
 * STORAGE_TYPE ni ACCESSIBLE.AFTER_FIRST_UNLOCK, que este helper usa. No se puede editar el
 * setup global (fuera de la propiedad de esta tarea), así que se completa aquí.
 */
jest.mock('react-native-keychain', () => ({
  __esModule: true,
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  setGenericPassword: jest.fn(() => Promise.resolve({service: 'test'})),
  ACCESSIBLE: {AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock'},
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth'},
}));

const getMock = Keychain.getGenericPassword as jest.Mock;
const setMock = Keychain.setGenericPassword as jest.Mock;

describe('secure-encryption-key (driver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('expone una clave de arranque transitoria (no la de seguridad real)', () => {
    expect(BOOTSTRAP_ENCRYPTION_KEY).toBe('veo-driver-bootstrap-v1');
  });

  it('primer arranque: genera 64 hex, guarda en Keystore y re-cifra', async () => {
    getMock.mockResolvedValueOnce(false);
    const recrypt = jest.fn();

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(true);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [, savedKey, options] = setMock.mock.calls[0];
    expect(savedKey).toMatch(/^[0-9a-f]{64}$/);
    expect(options.service).toBe('pe.veo.driver.mmkv.encryption-key');
    expect(options.accessible).toBe(Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK);
    expect(recrypt).toHaveBeenCalledWith(savedKey);
  });

  it('arranques siguientes: reutiliza la clave existente sin re-escribir', async () => {
    getMock.mockResolvedValueOnce({
      username: 'mmkv-secure-encryption-key',
      password: 'b'.repeat(64),
      service: 'pe.veo.driver.mmkv.encryption-key',
      storage: 'x',
    });
    const recrypt = jest.fn();

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(true);
    expect(setMock).not.toHaveBeenCalled();
    expect(recrypt).toHaveBeenCalledWith('b'.repeat(64));
  });

  it('fallback controlado: si el Keystore falla, no lanza y devuelve false', async () => {
    getMock.mockRejectedValueOnce(new Error('keystore boom'));
    const recrypt = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(false);
    expect(recrypt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
