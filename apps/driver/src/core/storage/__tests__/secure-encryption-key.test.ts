import { StoreId, SecureKey } from '../keys';

/**
 * Mock de react-native-mmkv con instancias REALISTAS respaldadas por un Map (por `id`), en vez de
 * jest.fn() vacíos. Así podemos verificar que abrir con la clave del Keystore LEE/ESCRIBE datos, con
 * qué config se abrió cada instancia, y que NUNCA se llama `recrypt` (el patrón que borraba la sesión).
 *
 * Nota: sobre-mockea el mock global de `jest.setup.js` para ESTE archivo (que necesita introspección).
 */
type MockInstance = {
  config: { id: string; encryptionKey?: string; encryptionType?: string };
  data: Map<string, string>;
  set: jest.Mock;
  getString: jest.Mock;
  remove: jest.Mock;
  clearAll: jest.Mock;
  recrypt: jest.Mock;
};

jest.mock('react-native-mmkv', () => {
  const instances: MockInstance[] = [];
  const createMMKV = jest.fn((config: MockInstance['config']) => {
    const data = new Map<string, string>();
    const inst: MockInstance = {
      config,
      data,
      set: jest.fn((k: string, v: unknown) => data.set(k, String(v))),
      getString: jest.fn((k: string) => (data.has(k) ? data.get(k) : undefined)),
      remove: jest.fn((k: string) => data.delete(k)),
      clearAll: jest.fn(() => data.clear()),
      // `recrypt` DEBE existir en el mock para PROBAR que nunca se llama (la cura de raíz lo elimina).
      recrypt: jest.fn(),
    };
    instances.push(inst);
    return inst;
  });
  return { __esModule: true, createMMKV, __instances: instances };
});

/**
 * Override local del mock de `react-native-keychain`: el mock global no expone STORAGE_TYPE ni
 * ACCESSIBLE.AFTER_FIRST_UNLOCK que el helper usa.
 */
jest.mock('react-native-keychain', () => ({
  __esModule: true,
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  setGenericPassword: jest.fn(() => Promise.resolve({ service: 'test' })),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock' },
  STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
}));

const EXISTING_KEY = 'b'.repeat(32);
const BOOTSTRAP_LITERAL = 'veo-driver-bootstrap-v1';

type Keychain = typeof import('react-native-keychain');
type MmkvMock = { createMMKV: jest.Mock; __instances: MockInstance[] };
type StorageModule = typeof import('../mmkv');
type KeyModule = typeof import('../secure-encryption-key');

function keychain(): {
  getMock: jest.Mock;
  setMock: jest.Mock;
} {
  const kc = require('react-native-keychain') as Keychain;
  return {
    getMock: kc.getGenericPassword as jest.Mock,
    setMock: kc.setGenericPassword as jest.Mock,
  };
}

function mmkvMock(): MmkvMock {
  return require('react-native-mmkv') as unknown as MmkvMock;
}

function secureInstance(): MockInstance | undefined {
  return mmkvMock().__instances.find((i) => i.config.id === StoreId.Secure);
}

function loadStorage(): StorageModule {
  return require('../mmkv') as StorageModule;
}

describe('almacén seguro (driver) — apertura directa con la clave del Keystore', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('primer arranque: genera clave AES-256 de 32 chars, la persiste y abre el store con ELLA', async () => {
    const { getMock, setMock } = keychain();
    getMock.mockResolvedValueOnce(false);

    const { initSecureStorage } = loadStorage();
    const ok = await initSecureStorage();

    expect(ok).toBe(true);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [, savedKey, options] = setMock.mock.calls[0] as [string, string, { service: string; accessible: string }];
    // 32 chars base64 (entropía completa del slot AES-256, NO 64 hex débiles).
    expect(savedKey).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(options.service).toBe('pe.veo.driver.mmkv.encryption-key');

    const secure = secureInstance();
    expect(secure).toBeDefined();
    expect(secure?.config.encryptionKey).toBe(savedKey);
    expect(secure?.config.encryptionType).toBe('AES-256');
  });

  it('arranques siguientes: reutiliza la clave del Keystore SIN re-escribir y abre con ELLA', async () => {
    const { getMock, setMock } = keychain();
    getMock.mockResolvedValueOnce({
      username: 'mmkv-secure-encryption-key',
      password: EXISTING_KEY,
      service: 'pe.veo.driver.mmkv.encryption-key',
      storage: 'x',
    });

    const { initSecureStorage } = loadStorage();
    const ok = await initSecureStorage();

    expect(ok).toBe(true);
    expect(setMock).not.toHaveBeenCalled();
    expect(secureInstance()?.config.encryptionKey).toBe(EXISTING_KEY);
  });

  it('NUNCA abre con la clave de arranque ni llama recrypt (cura de raíz del borrado de sesión)', async () => {
    const { getMock } = keychain();
    getMock.mockResolvedValueOnce({ username: 'x', password: EXISTING_KEY, service: 's', storage: 'x' });

    const { initSecureStorage } = loadStorage();
    await initSecureStorage();

    for (const inst of mmkvMock().__instances) {
      expect(inst.config.encryptionKey).not.toBe(BOOTSTRAP_LITERAL);
      expect(inst.recrypt).not.toHaveBeenCalled();
    }
  });

  it('tras init con Keystore, secureStore LEE/ESCRIBE datos (roundtrip sobre la instancia abierta)', async () => {
    const { getMock } = keychain();
    getMock.mockResolvedValueOnce({ username: 'x', password: EXISTING_KEY, service: 's', storage: 'x' });

    const { initSecureStorage, secureStore } = loadStorage();
    await initSecureStorage();

    secureStore.setString(SecureKey.AccessToken, 'jwt-123');
    expect(secureStore.getString(SecureKey.AccessToken)).toBe('jwt-123');
    // La escritura llegó a la instancia MMKV segura (no a otra).
    expect(secureInstance()?.data.get(SecureKey.AccessToken)).toBe('jwt-123');
  });

  it('ANTES de initSecureStorage, secureStore LANZA un error claro (no lee con clave equivocada)', () => {
    const { secureStore } = loadStorage();

    expect(() => secureStore.getString(SecureKey.AccessToken)).toThrow(/antes de initSecureStorage/);
    expect(() => secureStore.setString(SecureKey.AccessToken, 'x')).toThrow(/antes de initSecureStorage/);
    // El store seguro nunca se abrió porque nadie llamó init.
    expect(secureInstance()).toBeUndefined();
  });

  it('fallback EFÍMERO: si el Keystore falla tras los reintentos, degrada a memoria y devuelve false', async () => {
    const { getMock } = keychain();
    getMock.mockRejectedValue(new Error('keystore boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { initSecureStorage, secureStore } = loadStorage();
    const ok = await initSecureStorage();

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    // Sin MMKV seguro (cayó a memoria), pero el store FUNCIONA (no crashea el arranque).
    expect(secureInstance()).toBeUndefined();
    secureStore.setString(SecureKey.AccessToken, 'ephemeral');
    expect(secureStore.getString(SecureKey.AccessToken)).toBe('ephemeral');
    warn.mockRestore();
  });

  it('reintenta el Keystore ante fallos transitorios y se recupera (2 fallos → éxito)', async () => {
    const { getMock } = keychain();
    getMock
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce({ username: 'x', password: EXISTING_KEY, service: 's', storage: 'x' });

    const { initSecureStorage } = loadStorage();
    const ok = await initSecureStorage();

    expect(ok).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(secureInstance()?.config.encryptionKey).toBe(EXISTING_KEY);
  });

  it('initSecureStorage es idempotente (single-flight): abre el store una sola vez', async () => {
    const { getMock } = keychain();
    getMock.mockResolvedValue({ username: 'x', password: EXISTING_KEY, service: 's', storage: 'x' });

    const { initSecureStorage } = loadStorage();
    const [a, b] = await Promise.all([initSecureStorage(), initSecureStorage()]);
    await initSecureStorage();

    expect(a).toBe(true);
    expect(b).toBe(true);
    // Una única instancia segura creada pese a 3 llamadas.
    const secureCount = mmkvMock().__instances.filter((i) => i.config.id === StoreId.Secure).length;
    expect(secureCount).toBe(1);
  });
});

describe('getOrCreateEncryptionKey — entropía y persistencia', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('genera exactamente 32 chars base64 (192 bits de entropía en el slot AES-256)', async () => {
    const { getMock, setMock } = keychain();
    getMock.mockResolvedValueOnce(false);

    const { getOrCreateEncryptionKey } = require('../secure-encryption-key') as KeyModule;
    const key = await getOrCreateEncryptionKey();

    expect(key).toMatch(/^[A-Za-z0-9+/]{32}$/);
    const [, savedKey, options] = setMock.mock.calls[0] as [string, string, { accessible: string; storage: string }];
    expect(savedKey).toBe(key);
    expect(options.accessible).toBe('AccessibleAfterFirstUnlock');
    expect(options.storage).toBe('KeystoreAESGCM_NoAuth');
  });

  it('lanza KeystoreUnavailableError tras agotar los reintentos', async () => {
    const { getMock } = keychain();
    getMock.mockRejectedValue(new Error('boom'));

    const { getOrCreateEncryptionKey, SECURE_ENCRYPTION_KEY_META } =
      require('../secure-encryption-key') as KeyModule;

    await expect(getOrCreateEncryptionKey()).rejects.toThrow(/Keystore/);
    expect(getMock).toHaveBeenCalledTimes(SECURE_ENCRYPTION_KEY_META.maxAttempts);
  });
});
