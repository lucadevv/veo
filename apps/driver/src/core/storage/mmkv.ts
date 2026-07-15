// mmkv v4 (Nitro): `MMKV` ya NO es clase — es SOLO un type; las instancias se crean con la
// factory `createMMKV(config)`. `new MMKV(...)` compila (el type existe) pero en runtime es
// `undefined` → "TypeError: undefined cannot be used as a constructor" al arrancar.
import { createMMKV, type MMKV } from 'react-native-mmkv';
import { StoreId } from './keys';
import { SECURE_ENCRYPTION_TYPE, getOrCreateEncryptionKey } from './secure-encryption-key';

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

/**
 * Fallback EFÍMERO en memoria para el almacén seguro cuando el Keystore no está disponible tras los
 * reintentos. La app arranca y funciona; la sesión NO persiste entre lanzamientos (degradación honesta,
 * no un crash ni un login espurio silencioso). Se pierde al cerrar el proceso, por diseño.
 */
class InMemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  setString(key: string, value: string): void {
    this.data.set(key, value);
  }

  getObject<T>(key: string): T | undefined {
    const raw = this.data.get(key);
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
    this.data.set(key, JSON.stringify(value));
  }

  remove(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

/** Error tipado: se usó `secureStore` antes de que `initSecureStorage()` terminara. */
export class SecureStoreNotInitializedError extends Error {
  constructor() {
    super(
      'secureStore usado antes de initSecureStorage(): el almacén seguro se abre de forma ' +
        'asíncrona con la clave del Keystore. Await initSecureStorage() en el bootstrap ANTES de ' +
        'leer/escribir tokens (index.js lo dispara; App lo espera antes de hydrate()).',
    );
    this.name = 'SecureStoreNotInitializedError';
  }
}

/**
 * Holder LAZY del almacén seguro: delega a la implementación real (MMKV con la clave del Keystore o,
 * en fallback, memoria) una vez que `initSecureStorage()` la enlazó. Antes de eso, cualquier acceso
 * LANZA un error claro en vez de leer con una clave equivocada (que devolvía tokens null → login
 * espurio) o de borrar datos. El orden lo garantiza el bootstrap: `index.js` dispara init y `App`
 * lo espera antes de `hydrate()`.
 */
class LazySecureStore implements KeyValueStore {
  private delegate: KeyValueStore | null = null;

  bind(delegate: KeyValueStore): void {
    this.delegate = delegate;
  }

  private require(): KeyValueStore {
    if (!this.delegate) {
      throw new SecureStoreNotInitializedError();
    }
    return this.delegate;
  }

  getString(key: string): string | undefined {
    return this.require().getString(key);
  }

  setString(key: string, value: string): void {
    this.require().setString(key, value);
  }

  getObject<T>(key: string): T | undefined {
    return this.require().getObject<T>(key);
  }

  setObject<T>(key: string, value: T): void {
    this.require().setObject<T>(key, value);
  }

  remove(key: string): void {
    this.require().remove(key);
  }

  clear(): void {
    this.require().clear();
  }
}

// Almacén de PREFERENCIAS (no sensibles): idioma, último estado de turno conocido, etc. Sin cifrado,
// así que se crea síncrono al cargar el módulo (no depende del Keystore).
const prefsMmkv = createMMKV({ id: StoreId.Prefs });

// Almacén CIFRADO para datos sensibles (tokens, sesión). Se EXPONE síncrono (los consumidores lo
// importan síncrono) pero la instancia real se enlaza en `initSecureStorage()`: hasta entonces
// cualquier acceso lanza `SecureStoreNotInitializedError` (ver holder).
const lazySecureStore = new LazySecureStore();

export const secureStore: KeyValueStore = lazySecureStore;
export const prefsStore: KeyValueStore = new MmkvKeyValueStore(prefsMmkv);

/**
 * Promesa única de la apertura del almacén seguro. Memoizada (single-flight): la primera llamada
 * abre la instancia; las siguientes devuelven la MISMA promesa. Así `index.js` puede DISPARARLA
 * temprano y `App` (antes de `hydrate`) puede ESPERARLA sin re-abrir.
 */
let secureStorageReady: Promise<boolean> | null = null;

/**
 * Abre el almacén seguro DIRECTAMENTE con la clave del Keystore (sin clave de arranque, sin recrypt:
 * ver la doc de raíz en `./secure-encryption-key.ts`). Si el Keystore falla tras los reintentos,
 * degrada al almacén EFÍMERO en memoria y devuelve `false` (nunca crashea el arranque).
 */
async function openSecureStore(): Promise<boolean> {
  try {
    const encryptionKey = await getOrCreateEncryptionKey();
    const secureMmkv = createMMKV({
      id: StoreId.Secure,
      encryptionKey,
      encryptionType: SECURE_ENCRYPTION_TYPE,
    });
    lazySecureStore.bind(new MmkvKeyValueStore(secureMmkv));
    return true;
  } catch (error) {
    // Degradación honesta: la app funciona, la sesión no persiste ESTA vez. Visible para telemetría.

    console.warn(
      '[mmkv] Keystore no disponible tras reintentos; el almacén seguro cae a MEMORIA (efímero, la ' +
        'sesión no persistirá este lanzamiento). Error:',
      error,
    );
    lazySecureStore.bind(new InMemoryKeyValueStore());
    return false;
  }
}

/**
 * Inicializa la seguridad del almacén: recupera/genera la `encryptionKey` del Keychain/Keystore y
 * abre el almacén seguro con ELLA. Debe AWAITearse ANTES de leer/escribir tokens (la rehidratación de
 * sesión): antes de esto `secureStore` lanza `SecureStoreNotInitializedError`.
 * Memoizada/idempotente (single-flight), con fallback controlado (ver `openSecureStore`).
 *
 * @returns `true` si quedó activa la clave del Keystore; `false` si se degradó al fallback en memoria.
 */
export function initSecureStorage(): Promise<boolean> {
  if (!secureStorageReady) {
    secureStorageReady = openSecureStore();
  }
  return secureStorageReady;
}
