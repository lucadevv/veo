import * as Keychain from 'react-native-keychain';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  initSecureStorage,
} from '../secure-encryption-key';

/**
 * El mock global de `react-native-keychain` (jest.setup.js) ya expone
 * get/setGenericPassword y los enums ACCESSIBLE/STORAGE_TYPE usados aquí.
 */

const getMock = Keychain.getGenericPassword as jest.Mock;
const setMock = Keychain.setGenericPassword as jest.Mock;

describe('secure-encryption-key (passenger)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('la clave de arranque NO es la antigua constante embebida ni un secreto largo', () => {
    // La clave de arranque es solo transitoria, no la de seguridad real.
    expect(BOOTSTRAP_ENCRYPTION_KEY).toBe('veo-passenger-bootstrap-v1');
  });

  it('primer arranque: genera una clave de 64 hex, la guarda en Keychain y re-cifra', async () => {
    getMock.mockResolvedValueOnce(false); // no hay clave previa
    const recrypt = jest.fn();

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(true);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [, savedKey, options] = setMock.mock.calls[0];
    expect(savedKey).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(options.service).toBe('pe.veo.passenger.mmkv.encryption-key');
    expect(options.accessible).toBe(Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK);
    // Re-cifra con exactamente la clave generada.
    expect(recrypt).toHaveBeenCalledWith(savedKey);
  });

  it('arranques siguientes: reutiliza la clave existente sin volver a escribir', async () => {
    getMock.mockResolvedValueOnce({
      username: 'mmkv-secure-encryption-key',
      password: 'a'.repeat(64),
      service: 'pe.veo.passenger.mmkv.encryption-key',
      storage: 'x',
    });
    const recrypt = jest.fn();

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(true);
    expect(setMock).not.toHaveBeenCalled();
    expect(recrypt).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('fallback controlado: si el Keychain falla, no lanza y devuelve false', async () => {
    getMock.mockRejectedValueOnce(new Error('keychain boom'));
    const recrypt = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await initSecureStorage(recrypt);

    expect(ok).toBe(false);
    expect(recrypt).not.toHaveBeenCalled(); // se mantiene la clave de arranque
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
