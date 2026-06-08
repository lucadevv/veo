/**
 * Utilidades del token de seguimiento (BR-S05). El token es opaco pero su cuerpo
 * (base64url de "<shareId>.<expiresAtMs>.<nonce>") lleva la expiración en claro, así que el BFF
 * puede leerla SIN el secreto para construir la vista pública. La validación criptográfica y de
 * estado autoritativo la realiza share-service (a quien el BFF delega la verificación del token).
 */
import { ValidationError } from '@veo/utils';

export interface ShareTokenInfo {
  shareId: string;
  expiresAtMs: number;
}

/** Decodifica el cuerpo del token (sin verificar firma). Lanza si está malformado. */
export function parseShareToken(token: string): ShareTokenInfo {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) throw new ValidationError('Token de seguimiento malformado');
  const bodyB64 = token.slice(0, idx);
  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('Token de seguimiento malformado');
  }
  const parts = body.split('.');
  const shareId = parts[0];
  const expStr = parts[1];
  const expiresAtMs = Number(expStr);
  if (parts.length !== 3 || !shareId || !Number.isFinite(expiresAtMs)) {
    throw new ValidationError('Token de seguimiento malformado');
  }
  return { shareId, expiresAtMs };
}

/** Expiración del token como ISO-8601 (para la vista de seguimiento familiar). */
export function shareTokenExpiryIso(token: string): string {
  return new Date(parseShareToken(token).expiresAtMs).toISOString();
}
