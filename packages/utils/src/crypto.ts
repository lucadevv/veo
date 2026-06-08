/**
 * Primitivas criptográficas sobre node:crypto.
 * - HMAC para firma de requests de pánico (BR-S04, flujo §06 blueprint).
 * - SHA-256 + hash chaining para el audit log inmutable (BR audit, blueprint pilar 6).
 * - Hash de DNI (PII): no se guarda el DNI en claro (Ley 29733).
 *
 * NOTA: el hashing de contraseñas NO va aquí — usa argon2 en identity-service.
 */
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Firma HMAC-SHA256 en hex. */
export function signHmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Verificación HMAC en tiempo constante (resistente a timing attacks). */
export function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = signHmac(payload, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hash chaining para audit log: cada entrada incorpora el hash de la anterior.
 * Manipular cualquier entrada rompe la cadena → tampering detectable.
 */
export function chainHash(previousHash: string | null, entrySerialized: string): string {
  return sha256Hex(`${previousHash ?? 'GENESIS'}:${entrySerialized}`);
}

/** Hash determinista de PII para indexación sin exponer el dato (ej. dniHash). */
export function hashPii(value: string, salt: string): string {
  return sha256Hex(`${salt}:${value.trim().toUpperCase()}`);
}

/** Token aleatorio url-safe (OTP de contactos, share links opacos, etc.). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** OTP numérico de N dígitos (verificación de contactos de confianza, BR-I06). */
export function numericOtp(digits = 6): string {
  const max = 10 ** digits;
  const n = randomBytes(4).readUInt32BE(0) % max;
  return n.toString().padStart(digits, '0');
}
