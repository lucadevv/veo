/**
 * Cliente gRPC a identity-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto
 * canónico vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es el
 * contrato compartido DriverReply. Llama `GetDriver` para re-validar la elegibilidad del conductor en
 * el PUBLISH de una oferta de carpooling (ADR-014 §4.1/§8 · F1a).
 *
 * Defensa en profundidad: identity es la fuente AUTORITATIVA del estado suspendido/KYC/antecedentes. Si
 * identity no responde, el gate FALLA-CERRADO (no se permite publicar) — degradación honesta, nunca un
 * conductor no elegible colándose por un error de red. La implementación LANZA ante fallo; el gate del
 * service lo traduce a ForbiddenError.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type DriverReply, type GrpcServiceClient } from '@veo/rpc';
import type { IdentityClient, IdentityDriver } from './identity-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (gate de elegibilidad, sin usuario final ni BFF
 * detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcIdentityClient implements IdentityClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(identityGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('identity', { url: identityGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getDriver(driverId: string): Promise<IdentityDriver> {
    // Re-validación de elegibilidad: llamada de SISTEMA (no del usuario final). identity exige la
    // identidad interna firmada en la metadata; firmamos una identidad anónima de tipo 'driver' (sin
    // sesión real) con audiencia `service-rail` — la verificación HMAC + aud fail-closed pasa sin
    // reusar la identidad del conductor original.
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<DriverReply>('GetDriver', { id: driverId }, meta);
    return {
      id: reply.id,
      userId: reply.userId,
      currentStatus: reply.currentStatus,
      backgroundCheckStatus: reply.backgroundCheckStatus,
      kycStatus: reply.kycStatus,
      // proto3 manda '' cuando NO está suspendido → null honesto para el gate.
      suspendedAt: reply.suspendedAt || null,
      found: reply.found,
      // Campos PÚBLICOS para el detalle (F2): name/averageRating. El gate F1a no los usa; el detalle sí.
      name: reply.name,
      averageRating: reply.averageRating,
    };
  }
}
