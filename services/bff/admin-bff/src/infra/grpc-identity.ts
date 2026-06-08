/**
 * Construye la metadata gRPC con la identidad interna firmada (HMAC) que el BFF propaga a los
 * servicios en LECTURAS. Mismos headers que el REST interno; NUNCA se reenvía el JWT crudo.
 */
import {
  signInternalIdentity,
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  type AuthenticatedUser,
} from '@veo/auth';

export function grpcIdentityMeta(
  identity: AuthenticatedUser,
  secret: string,
): Record<string, string> {
  const { header, signature } = signInternalIdentity(identity, secret);
  return {
    [INTERNAL_IDENTITY_HEADER]: header,
    [INTERNAL_IDENTITY_SIG_HEADER]: signature,
  };
}
