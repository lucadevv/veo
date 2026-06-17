/**
 * Enlace de seguimiento firmado (BR-S05). Funciones puras → unit-testables sin I/O.
 *
 * El token entregado al usuario es opaco y auto-verificable:
 *   token = base64url("<shareId>.<expiresAtMs>.<nonce>") + "." + HMAC-SHA256(body, secret)
 * En la BD solo se guarda `tokenHash = sha256(token)` (nunca el token en claro).
 * Al abrir la página pública se valida la firma y la expiración criptográficamente (rápido y a prueba
 * de manipulación) y, además, el estado autoritativo (revocación, usos, expiración) contra la BD.
 */
import {
  randomToken,
  signHmac,
  verifyHmac,
  sha256Hex,
  ForbiddenError,
  UnauthorizedError,
} from '@veo/utils';

const SEP = '.';

export interface SignedShareToken {
  /** Token opaco para entregar al usuario (va en la URL). Solo existe en memoria, nunca se persiste. */
  token: string;
  /** sha256(token): lo único que se guarda en la BD. */
  tokenHash: string;
}

export interface ShareTokenClaims {
  shareId: string;
  expiresAtMs: number;
}

function encodeBody(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBody(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/** Firma un nuevo token de enlace para `shareId` con expiración `expiresAtMs`. */
export function signShareToken(
  shareId: string,
  expiresAtMs: number,
  secret: string,
): SignedShareToken {
  const nonce = randomToken(24);
  const body = `${shareId}${SEP}${expiresAtMs}${SEP}${nonce}`;
  const signature = signHmac(body, secret);
  const token = `${encodeBody(body)}${SEP}${signature}`;
  return { token, tokenHash: sha256Hex(token) };
}

/** sha256 del token (para buscar el ShareLink por `tokenHash`). */
export function tokenHashOf(token: string): string {
  return sha256Hex(token);
}

/**
 * Verifica firma y expiración del token.
 * - Firma inválida / token malformado → UnauthorizedError.
 * - Token expirado → ForbiddenError.
 */
export function verifyShareToken(
  token: string,
  secret: string,
  now = Date.now(),
): ShareTokenClaims {
  const idx = token.lastIndexOf(SEP);
  if (idx <= 0) throw new UnauthorizedError('Enlace de seguimiento inválido');

  const bodyB64 = token.slice(0, idx);
  const signature = token.slice(idx + 1);

  let body: string;
  try {
    body = decodeBody(bodyB64);
  } catch {
    throw new UnauthorizedError('Enlace de seguimiento inválido');
  }

  if (!verifyHmac(body, secret, signature)) {
    throw new UnauthorizedError('La firma del enlace de seguimiento no es válida');
  }

  const parts = body.split(SEP);
  const shareId = parts[0];
  const expStr = parts[1];
  if (parts.length !== 3 || shareId === undefined || expStr === undefined) {
    throw new UnauthorizedError('Enlace de seguimiento inválido');
  }

  const expiresAtMs = Number(expStr);
  if (!Number.isFinite(expiresAtMs)) {
    throw new UnauthorizedError('Enlace de seguimiento inválido');
  }
  if (now > expiresAtMs) {
    throw new ForbiddenError('El enlace de seguimiento expiró');
  }

  return { shareId, expiresAtMs };
}

export interface ShareLinkState {
  revokedAt: Date | null;
  expiresAt: Date;
  usedCount: number;
  maxUses: number;
}

/** Valida el estado autoritativo del enlace (BD): revocado / expirado / sin usos disponibles. */
export function assertShareLinkUsable(link: ShareLinkState, now = Date.now()): void {
  if (link.revokedAt) throw new ForbiddenError('El enlace de seguimiento fue revocado');
  if (link.expiresAt.getTime() <= now) throw new ForbiddenError('El enlace de seguimiento expiró');
  if (link.usedCount >= link.maxUses) {
    throw new ForbiddenError('El enlace de seguimiento alcanzó su límite de usos');
  }
}
