/**
 * Cifrado de secretos en reposo (AES-256-GCM). Usado para el secreto TOTP de operadores.
 * En producción la clave viene de KMS; aquí se deriva de un secreto de config.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** Cifra y devuelve "iv.tag.ciphertext" en base64. */
export function seal(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function open(sealed: string, secret: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new Error('secreto sellado inválido');
  const [iv, tag, enc] = parts.map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !enc) throw new Error('secreto sellado inválido');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
