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
  type VehiclesReply,
  type GrpcServiceClient,
} from '@veo/rpc';
import type { FleetClient, FleetVehicle, FleetVehicleView } from './fleet-client.port';

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

  async getVehicle(vehicleId: string): Promise<FleetVehicleView> {
    // DETALLE + RESERVA (F2 · Lote 3): UNA sola llamada que trae display PÚBLICO (modelo/placa/color) Y los
    // ejes de OPERABILIDAD (active/status/docStatus). El caller deriva la vista pública del display y GATEA la
    // operabilidad fail-closed (`isVehicleOperable`, fuente única con el publish). fail-closed: si fleet no
    // responde, la llamada LANZA y el caller no ofrece/reserva el vehículo (espeja el gate del conductor).
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<VehicleReply>('GetVehicle', { id: vehicleId }, meta);
    return toVehicleView(reply);
  }

  async getVehiclesOperability(
    vehicleIds: readonly string[],
  ): Promise<Map<string, FleetVehicleView>> {
    const byId = new Map<string, FleetVehicleView>();
    if (vehicleIds.length === 0) return byId;
    // BÚSQUEDA (Lote 3b): UNA llamada batch para TODOS los vehículos de la página (anti-N+1). El reply trae
    // solo los ENCONTRADOS; un id ausente del map = no operable para el caller. LANZA si fleet no responde.
    const meta = grpcIdentityMetadata(anonymousIdentity('driver'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<VehiclesReply>(
      'GetVehiclesByIds',
      { ids: [...vehicleIds] },
      meta,
    );
    for (const v of reply.vehicles ?? []) {
      if (v.found) byId.set(v.id, toVehicleView(v));
    }
    return byId;
  }
}

/** Mapea un VehicleReply del wire a la vista de booking (display + operabilidad). */
function toVehicleView(reply: VehicleReply): FleetVehicleView {
  return {
    id: reply.id,
    make: reply.make,
    model: reply.model,
    color: reply.color,
    plate: reply.plate,
    vehicleType: reply.vehicleType,
    found: reply.found,
    active: reply.active,
    status: reply.status,
    docStatus: reply.docStatus,
  };
}
