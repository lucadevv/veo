/**
 * Cliente gRPC BATCH a identity-service (producción) sobre la mecánica compartida de @veo/rpc. Llama
 * `GetDriversByIds` (DriversByIdsReply) para enriquecer los resultados de la BÚSQUEDA de viajes (F2, §6.2)
 * con los datos PÚBLICOS del conductor (name, averageRating) en UNA sola llamada — anti-N+1.
 *
 * Campos PÚBLICOS únicamente (minimización H8): se proyecta id/name/averageRating + los ejes de ELEGIBILIDAD
 * (currentStatus/suspendedAt/kycStatus/found) del DriverReply — nada de DNI/teléfono/PII (identity ni siquiera
 * los descifra en batch). La elegibilidad la consume el FILTRO de búsqueda (FIX 3): no se muestran ofertas de
 * conductores suspendidos / KYC-revocados después de publicar.
 *
 * Degradación HONESTA: si identity no responde, la implementación LANZA y el SERVICE captura el fallo y
 * devuelve los viajes SIN enriquecer (driver null) — la búsqueda NO se cuelga por identity caída.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type DriversByIdsReply, type GrpcServiceClient } from '@veo/rpc';
import type { IdentityBatchClient, PublicDriver } from './identity-batch-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (enriquecimiento server-side, sin usuario final detrás)
 * → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcIdentityBatchClient implements IdentityBatchClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(identityGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('identity', { url: identityGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getDriversByIds(ids: string[]): Promise<PublicDriver[]> {
    // Lista vacía → no se pega a la red (no hay conductores que resolver).
    if (ids.length === 0) return [];
    // Llamada de SISTEMA: identity exige la identidad interna firmada en la metadata; firmamos una identidad
    // anónima 'driver' (sin sesión) con audiencia `service-rail` (verificada per-service, fail-closed).
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<DriversByIdsReply>('GetDriversByIds', { ids }, meta);
    return (reply.drivers ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      averageRating: d.averageRating,
      // Ejes de elegibilidad (FIX 1·F2): identity los entrega en el MISMO reply batch (DriverReply). proto3
      // defaults:true → suspendedAt llega "" cuando NO está suspendido (nunca null); isDriverEligible lo trata.
      // backgroundCheckStatus se proyecta acá (el dato YA viaja en el wire) para que el predicado ÚNICO se evalúe
      // COMPLETO en la búsqueda — mismo criterio que publish/detail, sin asimetría (un no-cleared no se muestra).
      currentStatus: d.currentStatus,
      suspendedAt: d.suspendedAt,
      kycStatus: d.kycStatus,
      backgroundCheckStatus: d.backgroundCheckStatus,
      found: d.found,
    }));
  }
}
