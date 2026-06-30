/**
 * Cliente gRPC a identity-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto
 * canónico vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es
 * el contrato compartido DriverReply. Llama `GetDriver` para re-validar la elegibilidad del conductor
 * en el submit de una oferta (ADR 010 §6 · cierre del #9).
 *
 * Defensa en profundidad: identity es la fuente AUTORITATIVA del estado online/suspendido. Si identity
 * no responde, el gate FALLA-CERRADO (no se permite ofertar) — degradación honesta, nunca un conductor
 * no elegible colándose por un error de red.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type DriverReply, type GrpcServiceClient } from '@veo/rpc';
import type { IdentityClient, IdentityDriver } from './identity-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (gate de elegibilidad, sin usuario final ni
 * BFF detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
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
    const reply = await this.client.call<DriverReply>('GetDriver', { id: driverId }, this.meta());
    return this.toDriver(reply);
  }

  async getDriverByUser(userId: string): Promise<IdentityDriver> {
    // Resuelve User.id → perfil Driver (mismo DriverReply que GetDriver). Lo usa la exclusión por
    // suspensión del eje FLEET en la vía ITV, donde el evento viaja keyeado por User.id (= Vehicle.driverId).
    const reply = await this.client.call<DriverReply>('GetDriverByUser', { id: userId }, this.meta());
    return this.toDriver(reply);
  }

  /**
   * Metadata de SISTEMA (no del usuario final). identity exige la identidad interna firmada; firmamos una
   * identidad anónima de tipo 'driver' (sin sesión real) con audiencia `service-rail` — la verificación
   * HMAC + aud fail-closed pasa sin reusar la identidad del pasajero original.
   */
  private meta(): ReturnType<typeof grpcIdentityMetadata> {
    return grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
  }

  private toDriver(reply: DriverReply): IdentityDriver {
    return {
      id: reply.id,
      userId: reply.userId,
      currentStatus: reply.currentStatus,
      // proto3 manda '' cuando NO está suspendido → null honesto para el gate.
      suspendedAt: reply.suspendedAt || null,
      found: reply.found,
    };
  }
}
