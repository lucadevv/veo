/**
 * Cliente gRPC a trip-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto canónico
 * vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es el contrato
 * compartido TripReply. Llama `GetTrip` para validar el viaje en el submit de una calificación (gate
 * fail-closed de RatingsService.create): existe + COMPLETED + el rater participó.
 *
 * Fail-closed: trip es la fuente AUTORITATIVA del estado del viaje. Si trip no responde, el gate FALLA-
 * CERRADO (la llamada PROPAGA el error, no se califica) — nunca una calificación colándose sobre un
 * viaje que no se pudo verificar.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type TripReply, type GrpcServiceClient } from '@veo/rpc';
import type { TripClient, TripView } from './trip-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (gate fail-closed de RatingsService.create, sin
 * usuario final ni BFF detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcTripClient implements TripClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(tripGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('trip', { url: tripGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getTrip(tripId: string): Promise<TripView | null> {
    // Validación de viaje: llamada de SISTEMA (no del usuario final). trip.grpc exige la identidad
    // interna firmada en la metadata (verifyGrpcIdentity); firmamos una identidad anónima de tipo
    // 'passenger' (sin sesión real) con audiencia `service-rail` — la verificación HMAC + aud
    // fail-closed pasa sin reusar la identidad del rater.
    const meta = grpcIdentityMetadata(anonymousIdentity('passenger'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<TripReply>('GetTrip', { id: tripId }, meta);
    // proto3 con defaults:true entrega found=false (nunca null) cuando trip no existe → null honesto.
    if (!reply.found) return null;
    return {
      status: reply.status,
      passengerId: reply.passengerId,
      driverId: reply.driverId,
    };
  }
}
