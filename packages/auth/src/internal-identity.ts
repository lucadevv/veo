/**
 * Propagación de identidad BFF → servicio (decisión: validación solo en el BFF/gateway).
 * El BFF valida el JWT, luego firma un header de identidad interno con HMAC y lo propaga por gRPC/HTTP.
 * Los servicios confían en ese header SI la firma HMAC es válida (secreto interno compartido, mTLS en prod).
 *
 * Evita re-verificar el JWT en cada servicio, pero mantiene integridad: un cliente no puede forjar
 * identidad porque no conoce el secreto interno.
 */
import { signHmac, verifyHmac } from '@veo/utils';
import type { AuthenticatedUser } from './jwt.js';

export const INTERNAL_IDENTITY_HEADER = 'x-veo-identity';
export const INTERNAL_IDENTITY_SIG_HEADER = 'x-veo-identity-sig';

export interface InternalIdentity extends AuthenticatedUser {
  /** epoch(ms) en que el BFF emitió este header; los servicios rechazan headers viejos (anti-replay) */
  issuedAt: number;
}

export function signInternalIdentity(
  user: AuthenticatedUser,
  secret: string,
): { header: string; signature: string } {
  const identity: InternalIdentity = { ...user, issuedAt: Date.now() };
  const header = Buffer.from(JSON.stringify(identity)).toString('base64url');
  return { header, signature: signHmac(header, secret) };
}

export interface VerifyInternalIdentityOptions {
  /** ventana máxima de validez del header en ms (anti-replay). Default 30s. */
  maxAgeMs?: number;
}

export function verifyInternalIdentity(
  header: string,
  signature: string,
  secret: string,
  opts: VerifyInternalIdentityOptions = {},
): InternalIdentity | null {
  if (!header || !signature) return null;
  if (!verifyHmac(header, secret, signature)) return null;
  let identity: InternalIdentity;
  try {
    identity = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as InternalIdentity;
  } catch {
    return null;
  }
  const maxAge = opts.maxAgeMs ?? 30_000;
  if (Date.now() - identity.issuedAt > maxAge) return null;
  return identity;
}

/** Metadata gRPC entrante (estructural: Map-like de @grpc/grpc-js, sin acoplar este paquete a grpc). */
export interface GrpcMetadataLike {
  get(key: string): (string | Buffer)[];
}

function pickMetaValue(meta: GrpcMetadataLike, key: string): string {
  const first = meta.get(key)[0];
  if (first === undefined) return '';
  return typeof first === 'string' ? first : first.toString('utf8');
}

/**
 * Verifica la identidad interna firmada (HMAC) en la metadata gRPC entrante. Espejo server-side de lo
 * que firma el BFF/gateway. Devuelve la identidad o `null` si falta/inválida; el caller (controller gRPC)
 * decide cómo rechazar (típicamente RpcException UNAUTHENTICATED). Centraliza el parseo de metadata +
 * verify en UN lugar, para que cada servicio gRPC no lo re-implemente.
 */
export function verifyGrpcIdentity(
  meta: GrpcMetadataLike,
  secret: string,
  opts: VerifyInternalIdentityOptions = {},
): InternalIdentity | null {
  return verifyInternalIdentity(
    pickMetaValue(meta, INTERNAL_IDENTITY_HEADER),
    pickMetaValue(meta, INTERNAL_IDENTITY_SIG_HEADER),
    secret,
    opts,
  );
}
