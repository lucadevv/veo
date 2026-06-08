import { MMKV } from 'react-native-mmkv';
import {
  BOOTSTRAP_ENCRYPTION_KEY,
  initSecureStorage as initSecureStorageWithRecrypt,
} from './secure-encryption-key';

/**
 * Wrapper de persistencia sobre MMKV (3-5x más rápido que AsyncStorage; regla del repo).
 *
 * Dos almacenes separados por responsabilidad (SRP):
 *  - `secureStore`: datos sensibles (tokens de sesión). Cifrado con `encryptionKey`.
 *  - `prefsStore`:  preferencias y caché efímera no sensible.
 *
 * SEGURIDAD — `encryptionKey` desde Keychain/Keystore:
 * La clave del almacén seguro YA NO es una constante embebida. La instancia MMKV se crea
 * síncronamente con una clave de ARRANQUE temporal (consumidores siguen importándola
 * síncrona); en el bootstrap se llama `initSecureStorage()` que recupera/genera la clave
 * fuerte en el Keychain y RE-CIFRA el almacén con `recrypt`. Detalles en
 * `./secure-encryption-key.ts`.
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
      this.mmkv.delete(key);
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
    this.mmkv.delete(key);
  }

  clear(): void {
    this.mmkv.clearAll();
  }
}

/**
 * Instancia MMKV segura. Se crea con la clave de ARRANQUE; se re-cifra con la clave del
 * Keychain en `initSecureStorage()`. Privada al módulo: solo `recrypt` la toca desde aquí.
 */
const secureMmkv = new MMKV({
  id: 'veo.secure',
  encryptionKey: BOOTSTRAP_ENCRYPTION_KEY,
});

/** Almacén seguro (cifrado) para tokens y datos sensibles. */
export const secureStore: KeyValueStore = new MmkvStore(secureMmkv);

/** Almacén de preferencias / caché no sensible. */
export const prefsStore: KeyValueStore = new MmkvStore(
  new MMKV({ id: 'veo.prefs' }),
);

/**
 * Inicializa la seguridad del almacén: deriva la `encryptionKey` del Keychain/Keystore y
 * re-cifra el almacén seguro. Llamar en el bootstrap ANTES de leer tokens (p. ej. antes de
 * `hydrate()` de la sesión). Idempotente y con fallback controlado (ver helper).
 *
 * @returns `true` si quedó activa la clave del Keychain; `false` si se degradó al fallback.
 */
export function initSecureStorage(): Promise<boolean> {
  return initSecureStorageWithRecrypt((key) => secureMmkv.recrypt(key));
}
