import * as Keychain from 'react-native-keychain';

/**
 * Derivación de la `encryptionKey` del almacén MMKV seguro desde el almacén seguro del SO
 * (Keychain en iOS / Keystore en Android) vía `react-native-keychain`, en lugar de una
 * constante embebida en el bundle.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────
 * Una clave embebida viaja en el binario y es extraíble por ingeniería inversa; cualquiera
 * con el .aab podría descifrar el almacén MMKV. La clave real se genera aleatoriamente en
 * primer arranque y se persiste en hardware seguro (Keystore): NO vive en el bundle.
 *
 * ── Arranque sync vs async (decisión) ────────────────────────────────────────────────
 * `MMKV({ encryptionKey })` es SÍNCRONO al cargar el módulo y los consumidores
 * (`secureStore`/`prefsStore`) se importan síncronos; Keychain es async. Para NO cambiar la
 * firma pública de `KeyValueStore` ni obligar a editar archivos de otros agentes:
 *
 *   1. El almacén seguro se crea síncronamente con una clave de ARRANQUE temporal
 *      (`BOOTSTRAP_ENCRYPTION_KEY`). Esto solo cifra datos en el primerísimo instante,
 *      antes de que nadie haya leído/escrito tokens reales.
 *   2. En el bootstrap de la app (`index.js`) se llama `initSecureStorage()` (async) ANTES de
 *      leer tokens. Recupera (o genera y guarda) la clave fuerte del Keystore y RE-CIFRA el
 *      almacén con `MMKV.recrypt(key)`. A partir de ahí el almacén usa la clave del Keystore.
 *
 * `recrypt` migra los datos existentes en sitio, así que es seguro aunque ya hubiera datos
 * de un arranque previo cifrados con la misma clave del Keystore (idempotente).
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────────────
 * Si el Keystore falla (caso raro), NO se crashea el arranque: se mantiene la clave de
 * arranque y se loguea un WARN explícito. Es una degradación controlada y documentada.
 */

/** Servicio (namespace) de la clave de cifrado MMKV en el Keychain/Keystore. */
const SECURE_KEY_SERVICE = 'pe.veo.driver.mmkv.encryption-key';
/** Usuario fijo: solo guardamos una clave de cifrado por dispositivo. */
const SECURE_KEY_ACCOUNT = 'mmkv-secure-encryption-key';

/**
 * Clave de ARRANQUE temporal: solo cifra el almacén en el instante previo a `initSecureStorage()`.
 * NO es la clave de seguridad real (esa vive en el Keystore). Se exporta para que `mmkv.ts`
 * construya la instancia síncrona con ella.
 */
export const BOOTSTRAP_ENCRYPTION_KEY = 'veo-driver-bootstrap-v1';

/** Longitud de la clave generada: 32 bytes → 64 caracteres hex. */
const KEY_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Genera `KEY_BYTES` bytes aleatorios.
 *
 * Fuente preferida: `global.crypto.getRandomValues` (CSPRNG), provisto por
 * `react-native-get-random-values` (instalado e importado PRIMERO en `index.js`). Si por algún
 * motivo no estuviera disponible en el runtime, se cae a una mezcla best-effort basada en
 * tiempo + `Math.random()`.
 *
 * NOTA(seguridad): el fallback NO es criptográficamente fuerte y, con el polyfill instalado, NO
 * debería ejecutarse nunca. La clave se genera UNA sola vez y luego vive en hardware seguro.
 */
function generateRandomKeyHex(): string {
  const bytes = new Uint8Array(KEY_BYTES);

  const cryptoObj = (globalThis as {crypto?: Crypto}).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  // Fallback NO-CSPRNG (documentado). Mezcla tiempo de alta resolución + Math.random().
  // eslint-disable-next-line no-console
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
  return bytesToHex(bytes);
}

/**
 * Recupera la clave de cifrado del Keychain/Keystore; si no existe (primer arranque),
 * genera una nueva, la persiste y la devuelve. Lanza si el Keystore falla, para que el
 * llamador (initSecureStorage) decida el fallback.
 */
async function getOrCreateEncryptionKey(): Promise<string> {
  const existing = await Keychain.getGenericPassword({
    service: SECURE_KEY_SERVICE,
  });
  if (existing && existing.password) {
    return existing.password;
  }

  const key = generateRandomKeyHex();
  await Keychain.setGenericPassword(SECURE_KEY_ACCOUNT, key, {
    service: SECURE_KEY_SERVICE,
    // Debe poder leerse al arrancar tras el primer desbloqueo del día y solo en este device.
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
    // Android: clave en Keystore por hardware, sin biometría (el arranque no puede pedirla).
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  });
  return key;
}

/**
 * Inicializa el almacén seguro con la clave derivada del Keychain/Keystore.
 *
 * Debe llamarse en el bootstrap ANTES de leer tokens (p. ej. antes de `hydrate()` de la
 * sesión). Recupera/genera la clave fuerte y re-cifra el almacén MMKV con `recrypt`.
 *
 * @param recrypt callback que aplica `MMKV.recrypt(key)` sobre la instancia segura real.
 *                Se inyecta desde `mmkv.ts` (que posee la instancia) para no exponerla aquí.
 * @returns `true` si la clave del Keystore quedó activa; `false` si se degradó al fallback.
 */
export async function initSecureStorage(
  recrypt: (key: string) => void,
): Promise<boolean> {
  try {
    const key = await getOrCreateEncryptionKey();
    recrypt(key);
    return true;
  } catch (error) {
    // FALLBACK controlado: no crasheamos el arranque. El almacén sigue cifrado con la clave
    // de arranque (no ideal, pero funcional). Se loguea para visibilidad/telemetría.
    // eslint-disable-next-line no-console
    console.warn(
      '[secure-encryption-key] Keystore falló; el almacén seguro mantiene la clave de ' +
        'ARRANQUE (fallback degradado). Error:',
      error,
    );
    return false;
  }
}
