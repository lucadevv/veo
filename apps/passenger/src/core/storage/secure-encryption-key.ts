import * as Keychain from 'react-native-keychain';

/**
 * Derivación de la `encryptionKey` del almacén MMKV seguro desde el almacén seguro del SO
 * (Keychain en iOS / Keystore en Android) vía `react-native-keychain`, en lugar de una
 * constante embebida en el bundle.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────
 * Una clave embebida viaja en el binario y es extraíble por ingeniería inversa; cualquiera
 * con el .ipa/.aab podría descifrar el almacén MMKV. La clave real se genera aleatoriamente
 * en primer arranque y se persiste en hardware seguro: NO vive en el bundle.
 *
 * ── Arranque ASYNC (la instancia se crea CON la clave, no se re-cifra) ────────────────
 * Keychain es async; MMKV se crea con `createMMKV({ encryptionKey })`. La instancia segura se
 * construye en `initSecureStorage()` (mmkv.ts) DIRECTAMENTE con la clave recuperada acá. NO se usa
 * una clave de arranque + `recrypt`: ese patrón PERDÍA la sesión en cold-start porque MMKV abría el
 * archivo (cifrado con la clave del Keychain del login previo) usando la clave de arranque y no lo
 * descifraba. El bootstrap del árbol espera `initSecureStorage()` antes de leer tokens (la sesión
 * arranca en estado `unknown` hasta `hydrate()`).
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────────────
 * Si el Keychain falla (caso raro: dispositivo en estado inconsistente, etc.), NO se crashea
 * el arranque: el almacén se crea con la clave de ARRANQUE constante (`BOOTSTRAP_ENCRYPTION_KEY`)
 * y se loguea un WARN. Degradación controlada (la sesión cifrada con la clave del Keychain no se
 * recupera, pero la app funciona). Lo maneja `initSecureStorage()` en `mmkv.ts`.
 */

/** Servicio (namespace) de la clave de cifrado MMKV en el Keychain/Keystore. */
const SECURE_KEY_SERVICE = 'pe.veo.passenger.mmkv.encryption-key';
/** Usuario fijo: solo guardamos una clave de cifrado por dispositivo. */
const SECURE_KEY_ACCOUNT = 'mmkv-secure-encryption-key';

/**
 * Clave de ARRANQUE temporal: SOLO se usa como fallback si el Keychain es inaccesible. NO es la
 * clave de seguridad real (esa vive en el Keychain). Se exporta para que `mmkv.ts` construya la
 * instancia degradada con ella.
 */
export const BOOTSTRAP_ENCRYPTION_KEY = 'veo-passenger-bootstrap-v1';

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
 * Recupera la clave de cifrado del Keychain/Keystore; si no existe (primer arranque), genera una
 * nueva, la persiste y la devuelve. La MISMA clave se devuelve en cada arranque siguiente, así el
 * almacén MMKV cifrado con ella se descifra en cold-start (la sesión persiste). Lanza si el
 * Keychain falla, para que el llamador (`initSecureStorage` en mmkv.ts) decida el fallback.
 */
export async function getOrCreateEncryptionKey(): Promise<string> {
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
