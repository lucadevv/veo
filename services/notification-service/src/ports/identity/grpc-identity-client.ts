/**
 * Cliente gRPC a identity-service. ESPEJA `services/booking-service/src/identity/grpc-identity-client.ts`:
 * el .proto canónico vive en packages/rpc/proto (fuente única, nada vendorizado) y el reply es el contrato
 * compartido `DriverReply`. Acá SOLO usamos `GetDriver(driverId) → { userId }` para resolver el destinatario
 * de un push que viaja por `Driver.id` (ADR-015 D7).
 *
 * Llamada de SISTEMA (no del usuario final): identity exige la identidad interna firmada en la metadata;
 * firmamos una identidad ANÓNIMA de tipo 'driver' (sin sesión real) con audiencia `service-rail` — la
 * verificación HMAC + aud fail-closed pasa sin reusar la identidad de nadie (igual que booking).
 *
 * Degradación: la implementación LANZA ante fallo de transporte; el motor del push lo traduce a "omito el
 * push sin crashear el consumer" (no reintenta infinito contra identity). proto3 manda '' cuando no hay
 * conductor → se refleja en `found=false` / `userId=''`, que el motor trata como "omito limpio".
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type DriverReply, type GrpcServiceClient } from '@veo/rpc';
import type { IdentityClient, IdentityDriver } from './identity-client.port';

/** Audiencia de RIEL: es de SISTEMA (resolución de destinatario, sin BFF detrás) → `service-rail`. */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcIdentityClient implements IdentityClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(identityGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('identity', { url: identityGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getDriver(driverId: string): Promise<IdentityDriver> {
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<DriverReply>('GetDriver', { id: driverId }, meta);
    return {
      // proto3 manda '' cuando no hay conductor → lo dejamos pasar tal cual; el motor lo trata como vacío.
      userId: reply.userId,
      found: reply.found,
    };
  }
}
