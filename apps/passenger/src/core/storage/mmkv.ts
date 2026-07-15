// mmkv v4 (Nitro): `MMKV` ya NO es una clase exportada — es SOLO un type; las instancias se crean
// con la factory `createMMKV(config)`. `new MMKV(...)` compila en TS (el type existe) pero en
// runtime es `undefined` → "TypeError: undefined cannot be used as a constructor" al arrancar.
import {createMMKV, type MMKV} from 'react-native-mmkv';
import {StoreId} from './keys';
import {
  SECURE_ENCRYPTION_TYPE,
  getOrCreateEncryptionKey,
} from './secure-encryption-key';

/**
 * Wrapper de persistencia sobre MMKV (3-5x más rápido que AsyncStorage; regla del repo).
 *
 * Dos almacenes separados por responsabilidad (SRP):
 *  - `secureStore`: datos sensibles (tokens de sesión). Cifrado con la clave del Keychain/Keystore.
 *  - `prefsStore`:  preferencias y caché efímera no sensible (sin cifrar).
 *
 * SEGURIDAD — apertura DIRECTA con la clave del Keychain, almacén creado ASYNC:
 * La clave del almacén seguro NO es una constante embebida (extraíble del binario). La instancia
 * MMKV segura se crea en `initSecureStorage()` (async) DIRECTAMENTE con la clave recuperada del
 * Keychain/Keystore. ANTES se creaba síncrona con una clave de ARRANQUE y se re-cifraba con
 * `recrypt`: ese patrón PERDÍA la sesión en cold-start (MMKV abría el archivo cifrado-con-keychain
 * usando la clave de arranque → no descifraba → `recrypt` re-keyaba desde una vista VACÍA → BORRABA
 * la sesión). Ver la doc de raíz en `./secure-encryption-key.ts`. Ahora el arranque DEBE llamar y
 * ESPERAR `initSecureStorage()` antes de leer tokens: App.tsx lo encadena con `hydrate()`, y la
 * sesión arranca en estado `unknown` (splash) hasta que `hydrate()` corre.
 */

/** Contrato mínimo de un almacén clave-valor tipado. */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  setString(key: string, value: string): void;
  getJSON<T>(key: string): T | undefined;
  setJSON<T>(key: string, value: T): void;
  getBoolean(key: string): boolean | undefined;
  setBoolean(key: string, value: boolean): void;
  has(key: string): boolean;
  remove(key: string): void;
  clear(): void;
}

/** Adapta una instancia MMKV al contrato `KeyValueStore`. */
class MmkvStore implements KeyValueStore {
  constructor(private readonly mmkv: MMKV) {}

  getString(key: string): string | undefined {
    return this.mmkv.getString(key);
  }

  setString(key: string, value: string): void {
    this.mmkv.set(key, value);
  }

  getJSON<T>(key: string): T | undefined {
    const raw = this.mmkv.getString(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Valor corrupto: lo eliminamos para no propagar el error.
      this.mmkv.remove(key);
      return undefined;
    }
  }

  setJSON<T>(key: string, value: T): void {
    this.mmkv.set(key, JSON.stringify(value));
  }

  getBoolean(key: string): boolean | undefined {
    return this.mmkv.getBoolean(key);
  }

  setBoolean(key: string, value: boolean): void {
    this.mmkv.set(key, value);
  }

  has(key: string): boolean {
    return this.mmkv.contains(key);
  }

  remove(key: string): void {
    this.mmkv.remove(key);
  }

  clear(): void {
    this.mmkv.clearAll();
  }
}

/**
 * Fallback EFÍMERO en memoria para el almacén seguro cuando el Keychain no está disponible tras los
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

  getJSON<T>(key: string): T | undefined {
    const raw = this.data.get(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.data.delete(key);
      return undefined;
    }
  }

  setJSON<T>(key: string, value: T): void {
    this.data.set(key, JSON.stringify(value));
  }

  getBoolean(key: string): boolean | undefined {
    const raw = this.data.get(key);
    // Serialización booleana simétrica con `setBoolean` (String(value)) — sin literal mágico.
    return raw === undefined ? undefined : raw === String(true);
  }

  setBoolean(key: string, value: boolean): void {
    this.data.set(key, String(value));
  }

  has(key: string): boolean {
    return this.data.has(key);
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
        'asíncrona con la clave del Keychain. Await initSecureStorage() en el bootstrap ANTES de ' +
        'leer/escribir tokens (App.tsx lo encadena con hydrate()).',
    );
    this.name = 'SecureStoreNotInitializedError';
  }
}

/**
 * Holder LAZY del almacén seguro: delega a la implementación real (MMKV con la clave del Keychain o,
 * en fallback, memoria) una vez que `initSecureStorage()` la enlazó. Antes de eso, cualquier acceso
 * LANZA un error claro en vez de leer con una clave equivocada (que devolvía tokens null → login
 * espurio) o de borrar datos. El orden lo garantiza el bootstrap: App.tsx encadena
 * `initSecureStorage().then(hydrate)`.
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

  getJSON<T>(key: string): T | undefined {
    return this.require().getJSON<T>(key);
  }

  setJSON<T>(key: string, value: T): void {
    this.require().setJSON<T>(key, value);
  }

  getBoolean(key: string): boolean | undefined {
    return this.require().getBoolean(key);
  }

  setBoolean(key: string, value: boolean): void {
    this.require().setBoolean(key, value);
  }

  has(key: string): boolean {
    return this.require().has(key);
  }

  remove(key: string): void {
    this.require().remove(key);
  }

  clear(): void {
    this.require().clear();
  }
}

// Almacén de PREFERENCIAS (no sensibles): idioma, caché efímera, etc. Sin cifrado, así que se crea
// síncrono al cargar el módulo (no depende del Keychain).
const prefsMmkv = createMMKV({id: StoreId.Prefs});

// Almacén CIFRADO para datos sensibles (tokens, sesión). Se EXPONE síncrono (los consumidores lo
// importan síncrono) pero la instancia real se enlaza en `initSecureStorage()`: hasta entonces
// cualquier acceso lanza `SecureStoreNotInitializedError` (ver holder).
const lazySecureStore = new LazySecureStore();

/** Almacén seguro (cifrado con la clave del Keychain). Requiere `initSecureStorage()` previo. */
export const secureStore: KeyValueStore = lazySecureStore;

/** Almacén de preferencias / caché no sensible. */
export const prefsStore: KeyValueStore = new MmkvStore(prefsMmkv);

/**
 * Promesa única de la apertura del almacén seguro. Memoizada (single-flight): la primera llamada
 * abre la instancia; las siguientes devuelven la MISMA promesa. Así App.tsx puede DISPARARLA y
 * ESPERARLA sin re-abrir.
 */
let secureStorageReady: Promise<boolean> | null = null;

/**
 * Abre el almacén seguro DIRECTAMENTE con la clave del Keychain (sin clave de arranque, sin recrypt:
 * ver la doc de raíz en `./secure-encryption-key.ts`). Si el Keychain falla tras los reintentos,
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
    lazySecureStore.bind(new MmkvStore(secureMmkv));
    return true;
  } catch (error) {
    // Degradación honesta: la app funciona, la sesión no persiste ESTA vez. Visible para telemetría.
    console.warn(
      '[mmkv] Keychain no disponible tras reintentos; el almacén seguro cae a MEMORIA (efímero, la ' +
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
 * @returns `true` si quedó activa la clave del Keychain; `false` si se degradó al fallback en memoria.
 */
export function initSecureStorage(): Promise<boolean> {
  if (!secureStorageReady) {
    secureStorageReady = openSecureStore();
  }
  return secureStorageReady;
}
