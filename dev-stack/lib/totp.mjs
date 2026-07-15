/**
 * totp · Cálculo de TOTP (RFC 6238) para DEV — cero dependencias (crypto nativo de Node 20).
 *
 * Módulo compartido: lo consume el otp-viewer (panel admin) y el login.mjs (auto-login).
 * Antes esta función vivía duplicada en otp-viewer/server.mjs; se movió acá para tener UNA
 * sola fuente de verdad (mismo secreto → mismo código en ambos).
 */
import { createHmac } from 'node:crypto';

/** Decodifica base32 (RFC 4648, sin padding) a Buffer. */
export function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx !== -1) bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Código TOTP RFC 6238 (SHA1, 6 dígitos, ventana 30s) — mismos defaults que otplib. */
export function totp(secretBase32, atMs = Date.now(), period = 30, digits = 6) {
  const key = base32Decode(secretBase32);
  let counter = Math.floor(atMs / 1000 / period);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}
