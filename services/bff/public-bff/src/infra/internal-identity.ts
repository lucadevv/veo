/**
 * Propagación de identidad BFF → servicio para llamadas gRPC.
 * El REST interno la firma solo (vía InternalRestClient); para gRPC construimos aquí la metadata
 * con la identidad firmada HMAC. NUNCA se reenvía el JWT crudo aguas abajo.
 */
import {
  signInternalIdentity,
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  type AuthenticatedUser,
} from '@veo/auth';

/** Identidad de sistema para lecturas sin usuario final (p.ej. vista pública de seguimiento). */
export const ANONYMOUS_IDENTITY: AuthenticatedUser = {
  userId: 'anonymous',
  type: 'passenger',
  roles: [],
  sessionId: '',
};

/** Construye la metadata gRPC con la identidad interna firmada. */
export function internalGrpcMetadata(
  identity: AuthenticatedUser,
  secret: string,
): Record<string, string> {
  const { header, signature } = signInternalIdentity(identity, secret);
  return {
    [INTERNAL_IDENTITY_HEADER]: header,
    [INTERNAL_IDENTITY_SIG_HEADER]: signature,
  };
}
