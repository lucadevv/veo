/**
 * Cliente gRPC a fleet-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto canónico
 * vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es el contrato
 * compartido DriverVehiclesReply. Llama `GetDriverVehicles` para la validación ANTI-IDOR del vehículo al
 * publicar una oferta (ADR-014 §8 · F1a): el gate del service verifica que el vehicleId del body esté
 * entre los vehículos del conductor server-truth.
 *
 * POLÍTICA fail-closed: la implementación LANZA ante fallo de fleet; el gate del service lo traduce a
 * ForbiddenError (no se publica sin validar el vehículo) — nunca un vehículo no validado por error de red.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import {
  createGrpcClient,
  type DriverVehiclesReply,
  type VehicleReply,
  type GrpcServiceClient,
} from '@veo/rpc';
import type { FleetClient, FleetVehicle, PublicVehicle } from './fleet-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (validación de vehículo al publicar, sin usuario
 * final ni BFF detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcFleetClient implements FleetClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(fleetGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('fleet', { url: fleetGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getDriverVehicles(driverId: string): Promise<FleetVehicle[]> {
    // Llamada de SISTEMA al publicar (no del usuario final). fleet exige la identidad interna firmada
    // en la metadata; firmamos una identidad anónima de tipo 'driver' (sin sesión) con audiencia
    // `service-rail` (verificada per-service, fail-closed).
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<DriverVehiclesReply>(
      'GetDriverVehicles',
      { id: driverId },
      meta,
    );
    return (reply.vehicles ?? []).map((v) => ({
      id: v.id,
      docStatus: v.docStatus,
      active: v.active,
      status: v.status,
      vehicleType: v.vehicleType,
    }));
  }

  async getVehicle(vehicleId: string): Promise<PublicVehicle | null> {
    // Enriquecimiento del DETALLE (F2): datos PÚBLICOS del vehículo (modelo/placa/color). Degradación
    // HONESTA — si fleet no responde, devolvemos null y el detalle se arma sin el vehículo (no se cuelga).
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<VehicleReply>('GetVehicle', { id: vehicleId }, meta);
    if (!reply.found) return null;
    return {
      id: reply.id,
      make: reply.make,
      model: reply.model,
      color: reply.color,
      plate: reply.plate,
      vehicleType: reply.vehicleType,
      found: reply.found,
    };
  }
}
