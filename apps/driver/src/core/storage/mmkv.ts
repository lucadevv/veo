// mmkv v4 (Nitro): `MMKV` ya NO es clase — es SOLO un type; las instancias se crean con la
// factory `createMMKV(config)`. `new MMKV(...)` compila (el type existe) pero en runtime es
// `undefined` → "TypeError: undefined cannot be used as a constructor" al arrancar.
import {createMMKV, type MMKV} from 'react-native-mmkv';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  initSecureStorage as initSecureStorageWithRecrypt,
} from './secure-encryption-key';

/**
 * Abstracción de almacenamiento clave-valor (depender de la interfaz, no de MMKV directo).
 * Permite sustituir la implementación en pruebas o en otra plataforma sin tocar a los consumidores.
 */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  setString(key: string, value: string): void;
  getObject<T>(key: string): T | undefined;
  setObject<T>(key: string, value: T): void;
  remove(key: string): void;
  clear(): void;
}

/** Implementación de `KeyValueStore` sobre una instancia MMKV. */
class MmkvKeyValueStore implements KeyValueStore {
  constructor(private readonly mmkv: MMKV) {}

  getString(key: string): string | undefined {
    return this.mmkv.getString(key);
  }

  setString(key: string, value: string): void {
    this.mmkv.set(key, value);
  }

  getObject<T>(key: string): T | undefined {
    const raw = this.mmkv.getString(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  setObject<T>(key: string, value: T): void {
    this.mmkv.set(key, JSON.stringify(value));
  }

  remove(key: string): void {
    this.mmkv.remove(key);
  }

  clear(): void {
    this.mmkv.clearAll();
  }
}

// Almacén CIFRADO para datos sensibles (tokens, sesión).
// SEGURIDAD: la `encryptionKey` YA NO es una constante embebida. La instancia se crea
// síncronamente con una clave de ARRANQUE temporal (los consumidores la importan síncrona);
// en el bootstrap (`index.js`) se llama `initSecureStorage()`, que recupera/genera la clave
// fuerte en el Keystore (vía react-native-keychain) y RE-CIFRA el almacén con `recrypt`.
// Detalles y decisión de arranque en `./secure-encryption-key.ts`.
const secureMmkv = createMMKV({
  id: 'veo.driver.secure',
  encryptionKey: BOOTSTRAP_ENCRYPTION_KEY,
});

// Almacén de PREFERENCIAS (no sensibles): idioma, último estado de turno conocido, etc.
const prefsMmkv = createMMKV({id: 'veo.driver.prefs'});

export const secureStore: KeyValueStore = new MmkvKeyValueStore(secureMmkv);
export const prefsStore: KeyValueStore = new MmkvKeyValueStore(prefsMmkv);

/**
 * Promesa única del re-cifrado del almacén seguro. Memoizada (single-flight): la primera llamada
 * lanza el `recrypt`; las siguientes devuelven la MISMA promesa. Así `index.js` puede DISPARARLO
 * temprano y `App` (antes de `hydrate`) puede ESPERARLO sin re-cifrar dos veces.
 */
let secureStorageReady: Promise<boolean> | null = null;

/**
 * Inicializa la seguridad del almacén: deriva la `encryptionKey` del Keychain/Keystore y re-cifra el
 * almacén seguro. Debe AWAITearse ANTES de leer tokens (la rehidratación de sesión): leer antes del
 * `recrypt` descifra con la clave de ARRANQUE equivocada → tokens null → login espurio.
 * Memoizada/idempotente, con fallback controlado (ver helper).
 *
 * @returns `true` si quedó activa la clave del Keystore; `false` si se degradó al fallback.
 */
export function initSecureStorage(): Promise<boolean> {
  if (!secureStorageReady) {
    secureStorageReady = initSecureStorageWithRecrypt(key => secureMmkv.recrypt(key));
  }
  return secureStorageReady;
}
