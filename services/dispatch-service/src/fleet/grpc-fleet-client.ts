/**
 * Cliente gRPC a fleet-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto
 * canónico vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es
 * el contrato compartido VehicleReply. Llama `GetDriverActiveVehicle` (selector AUTORITATIVO ÚNICO
 * `pickActiveVehicle`, el MISMO que el gate de ITV y el ping del driver-bff) para resolver el vehículo
 * OPERADO del conductor al aceptar una oferta. El caller aplica fail-soft (si fleet no responde, la
 * asignación sigue sin vehículo) — la trazabilidad es deseable, NO bloqueante del viaje.
 */
import { anonymousIdentity, grpcIdentityMetadata, type InternalAudience } from '@veo/auth';
import { createGrpcClient, type VehicleReply, type GrpcServiceClient } from '@veo/rpc';
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
    // FUENTE ÚNICA del vehículo OPERADO: GetDriverActiveVehicle aplica el selector autoritativo
    // `pickActiveVehicle` server-side (el MISMO que el gate de ITV y el ping del driver-bff). ANTES acá se
    // re-derivaba con `vehicles.find(v.active) ?? vehicles[0]` — un algoritmo DISTINTO que podía adjuntar al
    // viaje un vehículo que NO era el operado (selectedAt/docs) y divergir del gate. `found=false` ⇒ null.
    const reply = await this.client.call<VehicleReply>(
      'GetDriverActiveVehicle',
      { id: driverId },
      meta,
    );
    return reply.found ? reply.id : null;
  }
}
