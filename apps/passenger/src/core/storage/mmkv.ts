// mmkv v4 (Nitro): `MMKV` ya NO es una clase exportada — es SOLO un type; las instancias se crean
// con la factory `createMMKV(config)`. `new MMKV(...)` compila en TS (el type existe) pero en
// runtime es `undefined` → "TypeError: undefined cannot be used as a constructor" al arrancar.
import {createMMKV, type MMKV} from 'react-native-mmkv';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  getOrCreateEncryptionKey,
} from './secure-encryption-key';

/**
 * Wrapper de persistencia sobre MMKV (3-5x más rápido que AsyncStorage; regla del repo).
 *
 * Dos almacenes separados por responsabilidad (SRP):
 *  - `secureStore`: datos sensibles (tokens de sesión). Cifrado con la clave del Keychain/Keystore.
 *  - `prefsStore`:  preferencias y caché efímera no sensible (sin cifrar).
 *
 * SEGURIDAD — `encryptionKey` del Keychain, almacén creado ASYNC:
 * La clave del almacén seguro NO es una constante embebida (extraíble del binario). La instancia
 * MMKV segura se crea en `initSecureStorage()` (async) DIRECTAMENTE con la clave recuperada del
 * Keychain/Keystore. ANTES se creaba síncrona con una clave de ARRANQUE y se re-cifraba con
 * `recrypt`: ese patrón PERDÍA la sesión en cold-start (MMKV abría el archivo cifrado-con-keychain
 * usando la clave de arranque → no descifraba → tokens "vacíos" → re-login forzado). Ahora el
 * arranque DEBE llamar y ESPERAR `initSecureStorage()` antes de leer tokens: App.tsx lo encadena
 * con `hydrate()`, y la sesión arranca en estado `unknown` (splash) hasta que `hydrate()` corre.
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

/** Adapta una instancia MMKV (resuelta de forma perezosa) al contrato `KeyValueStore`. */
class MmkvStore implements KeyValueStore {
  constructor(private readonly resolve: () => MMKV) {}

  getString(key: string): string | undefined {
    return this.resolve().getString(key);
  }

  setString(key: string, value: string): void {
    this.resolve().set(key, value);
  }

  getJSON<T>(key: string): T | undefined {
    const raw = this.resolve().getString(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Valor corrupto: lo eliminamos para no propagar el error.
      this.resolve().remove(key);
      return undefined;
    }
  }

  setJSON<T>(key: string, value: T): void {
    this.resolve().set(key, JSON.stringify(value));
  }

  getBoolean(key: string): boolean | undefined {
    return this.resolve().getBoolean(key);
  }

  setBoolean(key: string, value: boolean): void {
    this.resolve().set(key, value);
  }

  has(key: string): boolean {
    return this.resolve().contains(key);
  }

  remove(key: string): void {
    this.resolve().remove(key);
  }

  clear(): void {
    this.resolve().clearAll();
  }
}

/**
 * Instancia MMKV SEGURA. `null` hasta que `initSecureStorage()` la cree con la clave del Keychain.
 * Privada al módulo; se accede vía `secureStore` (que exige el init previo).
 */
let secureMmkv: MMKV | null = null;

/** Resuelve la instancia segura o falla con un mensaje claro si se leyó antes del bootstrap. */
function requireSecureMmkv(): MMKV {
  if (secureMmkv === null) {
    throw new Error(
      '[secureStore] leído antes de inicializar. Llamá y ESPERÁ `initSecureStorage()` en el ' +
        'bootstrap (App.tsx encadena `initSecureStorage().then(hydrate)`).',
    );
  }
  return secureMmkv;
}

/** Almacén de preferencias / caché no sensible (sin cifrar). Síncrono al import. */
const prefsMmkv = createMMKV({id: 'veo.prefs'});

/** Almacén seguro (cifrado con la clave del Keychain). Requiere `initSecureStorage()` previo. */
export const secureStore: KeyValueStore = new MmkvStore(requireSecureMmkv);

/** Almacén de preferencias / caché no sensible. */
export const prefsStore: KeyValueStore = new MmkvStore(() => prefsMmkv);

/**
 * Crea la instancia MMKV segura con la clave del Keychain/Keystore. Idempotente. Llamar y ESPERAR
 * en el bootstrap ANTES de leer tokens (App.tsx lo encadena con `hydrate()`); el resto del árbol no
 * lee `secureStore` hasta entonces (la sesión está en estado `unknown` → splash).
 *
 * @returns `true` si quedó activa la clave del Keychain; `false` si se degradó al fallback de
 *          arranque (Keychain inaccesible) — controlado, no crashea.
 */
export async function initSecureStorage(): Promise<boolean> {
  if (secureMmkv !== null) {
    return true; // idempotente
  }
  try {
    const key = await getOrCreateEncryptionKey();
    secureMmkv = createMMKV({id: 'veo.secure', encryptionKey: key});
    return true;
  } catch (error) {
    // FALLBACK controlado: el Keychain falló. Creamos el almacén con la clave de ARRANQUE constante
    // para no crashear el arranque; la sesión previa (cifrada con la clave del Keychain) NO será
    // legible (re-login), pero la app funciona. Se loguea para visibilidad/telemetría.
    secureMmkv = createMMKV({
      id: 'veo.secure',
      encryptionKey: BOOTSTRAP_ENCRYPTION_KEY,
    });
    console.warn(
      '[secure-encryption-key] Keychain inaccesible; almacén seguro con clave de ARRANQUE ' +
        '(degradado, la sesión previa no se recupera). Error:',
      error,
    );
    return false;
  }
}
