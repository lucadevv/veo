/**
 * Propagación de identidad BFF → servicio (decisión: validación solo en el BFF/gateway).
 * El BFF valida el JWT, luego firma un header de identidad interno con HMAC y lo propaga por gRPC/HTTP.
 * Los servicios confían en ese header SI la firma HMAC es válida (secreto interno compartido, mTLS en prod).
 *
 * Evita re-verificar el JWT en cada servicio, pero mantiene integridad: un cliente no puede forjar
 * identidad porque no conoce el secreto interno.
 *
 * ENDURECIMIENTO (audience scoping): el secreto HMAC es ÚNICO y compartido por los 14 servicios + 3 BFFs.
 * Si se filtra, se forja identidad de CUALQUIER rol/audiencia. Para acotar el radio de explosión, la
 * identidad firmada porta una AUDIENCIA DE RIEL (`aud`) que identifica QUIÉN la emitió (public/driver/admin
 * o una llamada de sistema service→service). Cada servicio declara qué audiencias acepta y RECHAZA
 * (fail-closed) cualquier identidad con `aud` ausente o no permitida. El secreto sigue único; el claim `aud`
 * acota qué riel puede pedir qué (FOUNDATION §14: sigue HMAC, el BFF sigue siendo autoridad de authz).
 */
import { signHmac, verifyHmac } from '@veo/utils';
import type { AuthenticatedUser } from './jwt.js';

export const INTERNAL_IDENTITY_HEADER = 'x-veo-identity';
export const INTERNAL_IDENTITY_SIG_HEADER = 'x-veo-identity-sig';

/**
 * Audiencia de RIEL: identifica el origen legítimo de una identidad interna firmada. Union TIPADA
 * centralizada — NUNCA un string mágico. Cada emisor firma con SU audiencia y cada servicio verifica
 * que el caller pertenezca a una audiencia que acepta.
 *  - `public-rail`  → public-bff (riel pasajero / family-web público).
 *  - `driver-rail`  → driver-bff (riel conductor).
 *  - `admin-rail`   → admin-bff (riel operador / back-office).
 *  - `service-rail` → llamadas de SISTEMA service→service (consumers, gates de elegibilidad, OTP por SMS,
 *                     biométrico) que no tienen un usuario final ni un riel-BFF detrás.
 */
export const InternalAudience = {
  PUBLIC_RAIL: 'public-rail',
  DRIVER_RAIL: 'driver-rail',
  ADMIN_RAIL: 'admin-rail',
  SERVICE_RAIL: 'service-rail',
} as const;
// El alias `type InternalAudience` se CONSERVA con el mismo nombre: los usos type-only
// (signInternalIdentity, InternalIdentity.aud, decoradores) siguen compilando y los literales
// 'driver-rail' siguen siendo asignables. NUNCA un string mágico — usá `InternalAudience.X`.
export type InternalAudience = (typeof InternalAudience)[keyof typeof InternalAudience];

/** Todas las audiencias válidas (fuente única para validación zod en los env de cada servicio). */
export const INTERNAL_AUDIENCES: readonly InternalAudience[] = Object.values(InternalAudience);

/** Type guard: ¿el string es una audiencia interna conocida? */
export function isInternalAudience(value: unknown): value is InternalAudience {
  return typeof value === 'string' && (INTERNAL_AUDIENCES as readonly string[]).includes(value);
}

export interface InternalIdentity extends AuthenticatedUser {
  /** epoch(ms) en que el BFF emitió este header; los servicios rechazan headers viejos (anti-replay) */
  issuedAt: number;
  /** Audiencia de riel del emisor (ver `InternalAudience`). Firmada dentro del HMAC: no se puede alterar. */
  aud: InternalAudience;
}

export function signInternalIdentity(
  user: AuthenticatedUser,
  secret: string,
  audience: InternalAudience,
): { header: string; signature: string } {
  const identity: InternalIdentity = { ...user, issuedAt: Date.now(), aud: audience };
  const header = Buffer.from(JSON.stringify(identity)).toString('base64url');
  return { header, signature: signHmac(header, secret) };
}

/**
 * Construye la metadata gRPC saliente con la identidad interna firmada (HMAC). Espejo CLIENT-side
 * de `verifyGrpcIdentity`: mismos headers que el REST interno; NUNCA se reenvía el JWT crudo aguas
 * abajo. Centralizado acá para que cada BFF/gateway no re-implemente el par header+firma.
 */
export function grpcIdentityMetadata(
  identity: AuthenticatedUser,
  secret: string,
  audience: InternalAudience,
): Record<string, string> {
  const { header, signature } = signInternalIdentity(identity, secret, audience);
  return {
    [INTERNAL_IDENTITY_HEADER]: header,
    [INTERNAL_IDENTITY_SIG_HEADER]: signature,
  };
}

/**
 * Identidad sintética ANÓNIMA para lecturas/passthroughs sin usuario final (p.ej. vista pública de
 * seguimiento, endpoints @Public de auth donde el downstream ignora la identidad pero el cliente
 * interno exige el header firmado). La FORMA vive acá una sola vez; cada BFF declara su sabor
 * (`anonymousIdentity('passenger')` / `anonymousIdentity('driver')`). `sessionId` vacío = sin
 * sesión real (señal honesta para audit/logs). La AUDIENCIA se decide en el punto de firma (un
 * passthrough de BFF firma con su riel; una llamada de sistema firma con `service-rail`).
 */
export function anonymousIdentity(type: AuthenticatedUser['type']): AuthenticatedUser {
  return { userId: 'anonymous', type, roles: [], sessionId: '' };
}

export interface VerifyInternalIdentityOptions {
  /** ventana máxima de validez del header en ms (anti-replay). Default 30s. */
  maxAgeMs?: number;
  /**
   * Audiencias de riel que ESTE verificador acepta. FAIL-CLOSED: si se provee, la identidad DEBE
   * portar un `aud` ∈ esta lista; `aud` ausente o ajena → rechazo (null). Si se OMITE (undefined), no
   * se verifica audiencia — reservado para callers legacy/tests; los guards de producción SIEMPRE la pasan.
   */
  allowedAudiences?: readonly InternalAudience[];
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
  // Verificación de audiencia (fail-closed): cuando el servicio declara qué rieles acepta, una identidad
  // sin `aud` o con un `aud` no permitido se RECHAZA aunque el HMAC sea válido. Acota el secreto único.
  if (opts.allowedAudiences) {
    if (!isInternalAudience(identity.aud)) return null;
    if (!opts.allowedAudiences.includes(identity.aud)) return null;
  }
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
 * verify en UN lugar, para que cada servicio gRPC no lo re-implemente. Pasá `opts.allowedAudiences` para
 * acotar qué rieles puede invocar este servicio (fail-closed).
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
