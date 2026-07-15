import * as Keychain from 'react-native-keychain';
import type {Configuration} from 'react-native-mmkv';

/**
 * Derivación de la `encryptionKey` del almacén MMKV seguro desde el almacén seguro del SO
 * (Keychain en iOS / Keystore en Android) vía `react-native-keychain`, en lugar de una
 * constante embebida en el bundle.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────
 * Una clave embebida viaja en el binario y es extraíble por ingeniería inversa; cualquiera
 * con el .ipa/.aab podría descifrar el almacén MMKV. La clave real se genera aleatoriamente en el
 * primer arranque y se persiste en hardware seguro (Keychain/Keystore): NO vive en el bundle.
 *
 * ── Apertura DIRECTA con la clave del Keychain (decisión) ──────────────────────────────
 * El patrón anterior "abrir con una clave de ARRANQUE temporal + `recrypt(keychainKey)`" tenía
 * un bug FATAL de pérdida de sesión en cada cold-start: en el 2º arranque el archivo en disco
 * está cifrado con la clave del Keychain, pero MMKV lo abría con la de ARRANQUE → no descifra →
 * `recrypt` (que asume que la clave actual descifra) re-keyaba desde una vista VACÍA → BORRABA
 * toda la sesión. Un pasajero perdía la sesión en cada reinicio.
 *
 * La cura de raíz es NO abrir nunca con una clave de arranque: se recupera/genera la clave del
 * Keychain (async) y se abre el almacén UNA vez con ELLA. Abrir MMKV con la clave correcta LEE
 * los datos existentes tal cual (comportamiento normal de MMKV). Sin `recrypt`, sin clave de
 * arranque. La orquestación (crear la instancia lazy) vive en `./mmkv.ts`, que posee el holder.
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────────────
 * Si el Keychain falla (device recién encendido/no desbloqueado → suele ser TRANSITORIO), se
 * reintenta unas pocas veces. Si aun así falla, NO se crashea el arranque: `mmkv.ts` degrada a
 * un almacén EN MEMORIA (efímero) y esta función deja que el error suba para que decida el
 * fallback. Es una degradación honesta y documentada.
 */

/** Servicio (namespace) de la clave de cifrado MMKV en el Keychain/Keystore. */
const SECURE_KEY_SERVICE = 'pe.veo.passenger.mmkv.encryption-key';
/** Usuario fijo: solo guardamos una clave de cifrado por dispositivo. */
const SECURE_KEY_ACCOUNT = 'mmkv-secure-encryption-key';

/**
 * Algoritmo de cifrado del almacén seguro.
 *
 * DOCS react-native-mmkv 4.x (`src/specs/MMKVFactory.nitro.ts`, campo `encryptionKey`):
 *   "Encryption keys can have a maximum length of 16 bytes with AES-128 encryption and 32 bytes
 *    with AES-256 encryption." — `encryptionType` default = `'AES-128'`.
 *
 * Con el default AES-128 MMKV solo consume los primeros 16 BYTES de la clave. El código previo
 * generaba 32 bytes en HEX (64 chars) sin declarar `encryptionType` → MMKV leía 16 chars hex =
 * 8 bytes de entropía real (64 bits). Optamos por AES-256 (32 bytes de clave) para usar el slot
 * completo. Tipo derivado de la config pública (sin string mágico ni `EncryptionType` — que el
 * paquete no reexporta).
 */
type EncryptionType = NonNullable<Configuration['encryptionType']>;
export const SECURE_ENCRYPTION_TYPE: EncryptionType = 'AES-256';

/**
 * Longitud de la clave en CHARS. La clave es ASCII (base64), así que 1 char = 1 byte UTF-8 al
 * cruzar el puente Nitro → 32 chars llenan EXACTAMENTE el slot de 32 bytes de AES-256.
 */
const SECURE_KEY_LENGTH = 32;

/**
 * Bytes CSPRNG a generar antes de codificar. 24 bytes → base64 → exactamente 32 chars (24 % 3 === 0,
 * sin padding). Eso mete 192 bits de entropía en los 32 bytes de clave (base64 = 6 bits/char).
 *
 * Por qué NO hex: hex acarrea 4 bits/char → 32 chars = 128 bits, "desperdicia" la mitad del slot.
 * 256 bits reales exigirían bytes 0x80–0xFF, que UTF-8 EXPANDE a 2 bytes al cruzar el puente (y el
 * 0x00 podría truncar) → cambiaría la longitud efectiva de la clave. base64 es ASCII puro y estable:
 * 192 bits es fuerte y determinista. `SECURE_KEY_RANDOM_BYTES * 4 / 3 === SECURE_KEY_LENGTH`.
 */
const SECURE_KEY_RANDOM_BYTES = 24;

/** Alfabeto base64 estándar (todo ASCII de 1 byte → estable al cruzar Nitro). */
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reintentos de acceso al Keychain ante fallos transitorios (device recién encendido/no desbloqueado). */
const KEYCHAIN_MAX_ATTEMPTS = 3;
/** Backoff base entre reintentos (crece linealmente por intento). Corto: el arranque no debe colgarse. */
const KEYCHAIN_RETRY_BACKOFF_MS = 20;

/** Error tipado: el Keychain no estuvo disponible tras agotar los reintentos. */
export class KeychainUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'No se pudo acceder al Keychain para la clave de cifrado del almacén seguro.',
    );
    this.name = 'KeychainUnavailableError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Codifica bytes a base64 (implementación propia, sin depender de `btoa`, que Hermes no garantiza).
 * Para `SECURE_KEY_RANDOM_BYTES` (múltiplo de 3) la salida no lleva padding.
 */
function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Genera `SECURE_KEY_RANDOM_BYTES` bytes aleatorios.
 *
 * Fuente preferida: `global.crypto.getRandomValues` (CSPRNG), provisto por
 * `react-native-get-random-values` (instalado e importado PRIMERO en `index.js`). Si por algún
 * motivo no estuviera disponible en el runtime, se cae a una mezcla best-effort basada en
 * tiempo + `Math.random()`.
 *
 * NOTA(seguridad): el fallback NO es criptográficamente fuerte y, con el polyfill instalado, NO
 * debería ejecutarse nunca. La clave se genera UNA sola vez y luego vive en hardware seguro.
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  const cryptoObj = (globalThis as {crypto?: Crypto}).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }

  // Fallback NO-CSPRNG (documentado). Mezcla tiempo de alta resolución + Math.random().
  console.warn(
    '[secure-encryption-key] crypto.getRandomValues no disponible; usando fallback ' +
      'NO criptográfico para generar la clave. Instala react-native-get-random-values.',
  );
  let seed = (Date.now() ^ (Date.now() << 13)) >>> 0;
  const perfNow =
    typeof globalThis.performance?.now === 'function'
      ? globalThis.performance.now()
      : Math.random() * 1e6;
  seed = (seed ^ Math.floor(perfNow * 1000)) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    // xorshift32 mezclado con Math.random() para dispersar.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    bytes[i] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
  }
  return bytes;
}

/**
 * Genera una clave de cifrado nueva: 32 chars base64 (ASCII) que llenan el slot de 32 bytes de
 * AES-256 con 192 bits de entropía. Ver notas de `SECURE_KEY_RANDOM_BYTES`/`SECURE_ENCRYPTION_TYPE`.
 */
function generateEncryptionKey(): string {
  return base64Encode(randomBytes(SECURE_KEY_RANDOM_BYTES));
}

/** Lee la clave existente del Keychain/Keystore; `null` si no hay (primer arranque). Puede lanzar. */
async function readExistingKey(): Promise<string | null> {
  const existing = await Keychain.getGenericPassword({
    service: SECURE_KEY_SERVICE,
  });
  return existing && existing.password ? existing.password : null;
}

/** Persiste una clave recién generada en el Keychain/Keystore. Puede lanzar. */
async function persistKey(key: string): Promise<void> {
  await Keychain.setGenericPassword(SECURE_KEY_ACCOUNT, key, {
    service: SECURE_KEY_SERVICE,
    // Debe poder leerse al arrancar tras el primer desbloqueo del día y solo en este device.
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
    // Android: clave en Keystore por hardware, sin biometría (el arranque no puede pedirla).
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  });
}

/**
 * Recupera la clave de cifrado del Keychain/Keystore; si no existe (primer arranque), genera una
 * nueva, la persiste y la devuelve.
 *
 * Reintenta ante fallos TRANSITORIOS del Keychain (device recién encendido/no desbloqueado):
 * hasta `KEYCHAIN_MAX_ATTEMPTS` con backoff lineal. Si se agotan, lanza `KeychainUnavailableError`
 * para que el llamador (`mmkv.ts`) degrade al almacén efímero en memoria — nunca crashea el arranque.
 */
export async function getOrCreateEncryptionKey(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= KEYCHAIN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const existing = await readExistingKey();
      if (existing) {
        return existing;
      }
      const key = generateEncryptionKey();
      await persistKey(key);
      return key;
    } catch (error) {
      lastError = error;
      if (attempt < KEYCHAIN_MAX_ATTEMPTS) {
        await delay(KEYCHAIN_RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw new KeychainUnavailableError(lastError);
}

/** Constantes exportadas para pruebas/consumidores (evita literales mágicos en asserts). */
export const SECURE_ENCRYPTION_KEY_META = {
  keyLength: SECURE_KEY_LENGTH,
  service: SECURE_KEY_SERVICE,
  account: SECURE_KEY_ACCOUNT,
  maxAttempts: KEYCHAIN_MAX_ATTEMPTS,
} as const;
