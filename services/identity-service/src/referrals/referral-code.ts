/**
 * Generación/normalización de códigos de referido (Ola 2A). Alfabeto sin caracteres ambiguos
 * (sin 0/O, 1/I/L) para dictado fácil. Longitud 8 → ~33^8 combinaciones, colisión improbable.
 */
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateReferralCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** Normaliza un código tecleado por el usuario: mayúsculas, sin espacios. */
export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}
