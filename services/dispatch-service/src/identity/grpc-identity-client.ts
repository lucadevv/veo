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
import { createGrpcClient, type DriverReply, type GrpcServiceClient } from '@veo/rpc';
import type { IdentityClient, IdentityDriver } from './identity-client.port';

export class GrpcIdentityClient implements IdentityClient {
  private readonly client: GrpcServiceClient;

  constructor(identityGrpcUrl: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('identity', { url: identityGrpcUrl, deadlineMs });
  }

  async getDriver(driverId: string): Promise<IdentityDriver> {
    const reply = await this.client.call<DriverReply>('GetDriver', { id: driverId });
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
