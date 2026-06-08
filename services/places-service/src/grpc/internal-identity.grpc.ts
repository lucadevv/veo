/**
 * Resolución de identidad interna en el borde gRPC del servicio. El BFF valida el JWT, firma la
 * identidad (HMAC) y la propaga en la metadata gRPC; aquí la VERIFICAMOS (vía `@veo/rpc`, el verify
 * canónico) y extraemos el userId del contexto autenticado.
 *
 * Decisión de seguridad (anti-IDOR): el userId NUNCA viaja en el cuerpo del request. Si la metadata
 * falta o la firma no valida, se rechaza (UNAUTHENTICATED). Así un cliente no puede operar sobre los
 * lugares de otro usuario falsificando un userId en el payload.
 */
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { verifyGrpcIdentity, type AuthenticatedUser } from '@veo/auth';

/**
 * Verifica la identidad interna firmada en la metadata y devuelve el usuario autenticado.
 * Lanza RpcException(UNAUTHENTICATED) si falta o es inválida. El verify lo centraliza `@veo/rpc`.
 */
export function requireInternalIdentity(meta: Metadata, secret: string): AuthenticatedUser {
  const identity = verifyGrpcIdentity(meta, secret);
  if (!identity) {
    throw new RpcException({
      code: GrpcStatus.UNAUTHENTICATED,
      message: 'Identidad interna inválida o ausente',
    });
  }
  return identity;
}
