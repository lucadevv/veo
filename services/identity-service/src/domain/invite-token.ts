/**
 * Token de invitación de operador admin (onboarding por invitación).
 *
 * El superadmin crea al operador → se acuña un token de un solo uso. El TOKEN EN CLARO viaja una sola
 * vez (en el link/email); en la DB solo persiste su HASH sha256 (`inviteTokenHash`), nunca el claro
 * (mismo criterio que OTPs/reset: el secreto no se guarda recuperable). Al aceptar, se re-hashea el
 * token recibido y se busca por hash. Limpiar el hash tras aceptar lo invalida (un solo uso).
 *
 * Funciones puras (sin DI, sin estado) → unit-testeables.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Vigencia de la invitación en horas. */
export const INVITE_TTL_HOURS = 48;

const MS_PER_HOUR = 60 * 60 * 1000;

/** sha256 hex del token (para persistir/buscar; nunca el token en claro). */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface GeneratedInviteToken {
  /** Token en claro (256 bits, base64url). Viaja UNA sola vez en el link; no se persiste. */
  token: string;
  /** sha256 hex del token (lo que se guarda en `inviteTokenHash`). */
  tokenHash: string;
  /** Expiración = ahora + INVITE_TTL_HOURS. */
  expiresAt: Date;
}

/** Acuña un token de invitación: claro + hash + expiración (now + 48h). */
export function generateInviteToken(): GeneratedInviteToken {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * MS_PER_HOUR);
  return { token, tokenHash, expiresAt };
}
