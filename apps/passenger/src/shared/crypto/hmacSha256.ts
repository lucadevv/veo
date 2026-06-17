/**
 * HMAC-SHA256 puro en JavaScript (Hermes-compatible: no usa `node:crypto`, ausente en RN).
 *
 * Se necesita para la firma del pánico (BR-S04): el backend valida
 * `HMAC_SHA256(mensaje, secreto)` en hex. La implementación está verificada contra los
 * vectores de prueba oficiales RFC 4231 en los tests unitarios.
 *
 * SRP: este módulo solo hace criptografía de hashing; no conoce el contrato del pánico.
 */

const BLOCK_SIZE = 64; // 512 bits

/** Constantes de ronda de SHA-256 (raíces cúbicas de los primeros 64 primos). */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 de un arreglo de bytes; devuelve 32 bytes. */
function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  // Padding: 1 bit + ceros + longitud en bits (64 bits big-endian).
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(message);
  bytes[message.length] = 0x80;
  // Longitud en bits en los últimos 8 bytes (solo soportamos < 2^32 bits, suficiente aquí).
  const dv = new DataView(bytes.buffer);
  dv.setUint32(paddedLength - 4, bitLength >>> 0, false);
  dv.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += BLOCK_SIZE) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i]!, false);
  }
  return out;
}

/** Codifica una cadena a bytes UTF-8 (sin depender de TextEncoder, no garantizado en Hermes viejo). */
function utf8Bytes(input: string): Uint8Array {
  const result: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      result.push(code);
    } else if (code < 0x800) {
      result.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Par sustituto (surrogate pair) → punto de código completo.
      const next = input.charCodeAt(i + 1);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      i += 1;
      result.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      result.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(result);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * HMAC-SHA256 en hexadecimal.
 * @param message Mensaje (string UTF-8) a firmar.
 * @param secret  Secreto compartido (string UTF-8).
 */
export function hmacSha256Hex(message: string, secret: string): string {
  let keyBytes = utf8Bytes(secret);
  // Claves más largas que el bloque se reemplazan por su hash (RFC 2104).
  if (keyBytes.length > BLOCK_SIZE) {
    keyBytes = sha256(keyBytes);
  }

  const block = new Uint8Array(BLOCK_SIZE);
  block.set(keyBytes);

  const innerPad = new Uint8Array(BLOCK_SIZE);
  const outerPad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    innerPad[i] = block[i]! ^ 0x36;
    outerPad[i] = block[i]! ^ 0x5c;
  }

  const messageBytes = utf8Bytes(message);
  const inner = new Uint8Array(BLOCK_SIZE + messageBytes.length);
  inner.set(innerPad);
  inner.set(messageBytes, BLOCK_SIZE);
  const innerHash = sha256(inner);

  const outer = new Uint8Array(BLOCK_SIZE + innerHash.length);
  outer.set(outerPad);
  outer.set(innerHash, BLOCK_SIZE);

  return toHex(sha256(outer));
}
