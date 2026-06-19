/**
 * Cliente gRPC a fleet-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto
 * canónico vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es
 * el contrato compartido DriverVehiclesReply. Llama `GetDriverVehicles` para resolver el vehículo
 * ACTIVO del conductor al aceptar una oferta. El caller aplica fail-soft (si fleet no responde, la
 * asignación sigue sin vehículo) — la trazabilidad es deseable, NO bloqueante del viaje.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type DriverVehiclesReply, type GrpcServiceClient } from '@veo/rpc';
import type { FleetClient } from './fleet-client.port';

/**
 * Audiencia de RIEL de esta llamada: es de SISTEMA (resolución de vehículo al aceptar oferta, sin
 * usuario final ni BFF detrás) → `service-rail`. Const TIPADA (InternalAudience), nunca string mágico.
 */
const SERVICE_RAIL: InternalAudience = 'service-rail';

export class GrpcFleetClient implements FleetClient {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(fleetGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('fleet', { url: fleetGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getActiveVehicleId(driverId: string): Promise<string | null> {
    // Llamada de SISTEMA al aceptar una oferta (no del usuario final). fleet exige la identidad
    // interna firmada en la metadata; firmamos una identidad anónima de tipo 'driver' (sin sesión)
    // con audiencia `service-rail` (verificada per-service, fail-closed).
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<DriverVehiclesReply>(
      'GetDriverVehicles',
      { id: driverId },
      meta,
    );
    const vehicles = reply.vehicles ?? [];
    // El vehículo activo del conductor; si ninguno marca activo, el primero (en dev hay 1 por conductor).
    const active = vehicles.find((v) => v.active) ?? vehicles[0];
    return active?.id ?? null;
  }
}
