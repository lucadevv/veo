/**
 * Cliente gRPC a fleet-service (producción). Carga `proto/fleet.proto` (vendorizado en este servicio,
 * igual que identity.proto) y llama `GetDriverVehicles` para resolver el vehículo ACTIVO del conductor
 * al aceptar una oferta. El caller aplica fail-soft (si fleet no responde, la asignación sigue sin
 * vehículo) — la trazabilidad es deseable, NO bloqueante del viaje.
 */
import { join } from 'node:path';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type CallOptions,
  type GrpcObject,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { FleetClient } from './fleet-client.port';

/** Forma cruda del VehicleReply (snake→camel por proto-loader keepCase:false). Solo lo que usamos. */
interface RawVehicle {
  id: string;
  active: boolean;
}

interface RawDriverVehiclesReply {
  driverId: string;
  vehicles: RawVehicle[];
}

interface FleetGrpcService {
  GetDriverVehicles(
    req: { id: string },
    metadata: Metadata,
    options: CallOptions,
    cb: (err: Error | null, res?: RawDriverVehiclesReply) => void,
  ): void;
}

export class GrpcFleetClient implements FleetClient {
  private readonly client: FleetGrpcService;
  private readonly deadlineMs: number;

  constructor(fleetGrpcUrl: string, deadlineMs = 2_000) {
    this.deadlineMs = deadlineMs;
    const def = loadSync(join(__dirname, '../../proto/fleet.proto'), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackage(loadPackageDefinition(def));
    const ctor = pkg.veo.fleet.v1.FleetService;
    this.client = new ctor(
      fleetGrpcUrl,
      credentials.createInsecure(),
    ) as unknown as FleetGrpcService;
  }

  async getActiveVehicleId(driverId: string): Promise<string | null> {
    const deadline = new Date(Date.now() + this.deadlineMs);
    const reply = await new Promise<RawDriverVehiclesReply>((resolve, reject) => {
      this.client.GetDriverVehicles({ id: driverId }, new Metadata(), { deadline }, (err, res) => {
        if (err || !res) {
          reject(err ?? new Error('respuesta vacía de fleet.GetDriverVehicles'));
          return;
        }
        resolve(res);
      });
    });
    const vehicles = reply.vehicles ?? [];
    // El vehículo activo del conductor; si ninguno marca activo, el primero (en dev hay 1 por conductor).
    const active = vehicles.find((v) => v.active) ?? vehicles[0];
    return active?.id ?? null;
  }
}

/** Navegación tipada mínima del árbol de paquetes del proto (evita `any`). */
interface FleetPackageTree {
  veo: { fleet: { v1: { FleetService: ServiceClientConstructor } } };
}

function loadPackage(root: GrpcObject): FleetPackageTree {
  return root as unknown as FleetPackageTree;
}
