/**
 * Cliente gRPC a fleet-service (producción) sobre la mecánica compartida de @veo/rpc: el .proto
 * canónico vive en packages/rpc/proto (fuente única, nada vendorizado acá) y el shape del reply es
 * el contrato compartido DriverVehiclesReply. Llama `GetDriverVehicles` para resolver el vehículo
 * ACTIVO del conductor al aceptar una oferta. El caller aplica fail-soft (si fleet no responde, la
 * asignación sigue sin vehículo) — la trazabilidad es deseable, NO bloqueante del viaje.
 */
import { createGrpcClient, type DriverVehiclesReply, type GrpcServiceClient } from '@veo/rpc';
import type { FleetClient } from './fleet-client.port';

export class GrpcFleetClient implements FleetClient {
  private readonly client: GrpcServiceClient;

  constructor(fleetGrpcUrl: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('fleet', { url: fleetGrpcUrl, deadlineMs });
  }

  async getActiveVehicleId(driverId: string): Promise<string | null> {
    const reply = await this.client.call<DriverVehiclesReply>('GetDriverVehicles', { id: driverId });
    const vehicles = reply.vehicles ?? [];
    // El vehículo activo del conductor; si ninguno marca activo, el primero (en dev hay 1 por conductor).
    const active = vehicles.find((v) => v.active) ?? vehicles[0];
    return active?.id ?? null;
  }
}
