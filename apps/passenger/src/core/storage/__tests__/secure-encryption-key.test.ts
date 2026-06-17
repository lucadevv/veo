import * as Keychain from 'react-native-keychain';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  getOrCreateEncryptionKey,
} from '../secure-encryption-key';

/**
 * El mock global de `react-native-keychain` (jest.setup.js) ya expone
 * get/setGenericPassword y los enums ACCESSIBLE/STORAGE_TYPE usados aquí.
 *
 * `getOrCreateEncryptionKey` es la unidad pura: recupera la clave del Keychain o la genera. La
 * ESTABILIDAD de la clave entre arranques es lo que hace que el almacén MMKV (cifrado con ella) se
 * descifre en cold-start y la sesión persista. El fallback (crear la instancia MMKV con la clave de
 * arranque si el Keychain falla) vive en `initSecureStorage()` de `mmkv.ts`.
 */

const getMock = Keychain.getGenericPassword as jest.Mock;
const setMock = Keychain.setGenericPassword as jest.Mock;

describe('secure-encryption-key (passenger)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('la clave de arranque es solo el fallback transitorio, no la de seguridad real', () => {
    expect(BOOTSTRAP_ENCRYPTION_KEY).toBe('veo-passenger-bootstrap-v1');
  });

  it('primer arranque: genera una clave de 64 hex y la guarda en el Keychain', async () => {
    getMock.mockResolvedValueOnce(false); // no hay clave previa

    const key = await getOrCreateEncryptionKey();

    expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(setMock).toHaveBeenCalledTimes(1);
    const [, savedKey, options] = setMock.mock.calls[0];
    expect(savedKey).toBe(key); // guarda EXACTAMENTE la generada
    expect(options.service).toBe('pe.veo.passenger.mmkv.encryption-key');
    expect(options.accessible).toBe(Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK);
  });

  it('arranques siguientes: reutiliza la MISMA clave sin volver a escribir (clave estable → la sesión persiste)', async () => {
    getMock.mockResolvedValueOnce({
      username: 'mmkv-secure-encryption-key',
      password: 'a'.repeat(64),
      service: 'pe.veo.passenger.mmkv.encryption-key',
      storage: 'x',
    });

    const key = await getOrCreateEncryptionKey();

    expect(key).toBe('a'.repeat(64));
    expect(setMock).not.toHaveBeenCalled();
  });

  it('si el Keychain falla, LANZA (el llamador `initSecureStorage` decide el fallback)', async () => {
    getMock.mockRejectedValueOnce(new Error('keychain boom'));

    await expect(getOrCreateEncryptionKey()).rejects.toThrow('keychain boom');
    expect(setMock).not.toHaveBeenCalled();
  });
});
