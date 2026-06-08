/**
 * Cliente gRPC a identity-service (producción). Carga `proto/identity.proto` (vendorizado en este
 * servicio, como hace dispatch con su propio proto en main.ts) y llama `GetDriver` para re-validar
 * la elegibilidad del conductor en el submit de una oferta (ADR 010 §6 · cierre del #9).
 *
 * Defensa en profundidad: identity es la fuente AUTORITATIVA del estado online/suspendido. Si identity
 * no responde, el gate FALLA-CERRADO (no se permite ofertar) — degradación honesta, nunca un conductor
 * no elegible colándose por un error de red.
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
import type { IdentityClient, IdentityDriver } from './identity-client.port';

/** Forma cruda del DriverReply del proto (snake→camel lo hace proto-loader con keepCase:false). */
interface RawDriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
  suspendedAt: string;
}

interface IdentityGrpcService {
  GetDriver(
    req: { id: string },
    metadata: Metadata,
    options: CallOptions,
    cb: (err: Error | null, res?: RawDriverReply) => void,
  ): void;
}

export class GrpcIdentityClient implements IdentityClient {
  private readonly client: IdentityGrpcService;
  private readonly deadlineMs: number;

  constructor(identityGrpcUrl: string, deadlineMs = 2_000) {
    this.deadlineMs = deadlineMs;
    const def = loadSync(join(__dirname, '../../proto/identity.proto'), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    // proto-loader da la definición; loadPackageDefinition la convierte en el árbol de paquetes gRPC.
    const pkg = loadPackage(loadPackageDefinition(def));
    const ctor = pkg.veo.identity.v1.IdentityService;
    this.client = new ctor(
      identityGrpcUrl,
      credentials.createInsecure(),
    ) as unknown as IdentityGrpcService;
  }

  async getDriver(driverId: string): Promise<IdentityDriver> {
    const deadline = new Date(Date.now() + this.deadlineMs);
    const reply = await new Promise<RawDriverReply>((resolve, reject) => {
      this.client.GetDriver({ id: driverId }, new Metadata(), { deadline }, (err, res) => {
        if (err || !res) {
          reject(err ?? new Error('respuesta vacía de identity.GetDriver'));
          return;
        }
        resolve(res);
      });
    });
    return {
      id: reply.id,
      userId: reply.userId,
      currentStatus: reply.currentStatus,
      suspendedAt: reply.suspendedAt && reply.suspendedAt.length > 0 ? reply.suspendedAt : null,
      found: reply.found,
    };
  }
}

/** Navegación tipada mínima del árbol de paquetes del proto (evita `any`). */
interface IdentityPackageTree {
  veo: { identity: { v1: { IdentityService: ServiceClientConstructor } } };
}

function loadPackage(root: GrpcObject): IdentityPackageTree {
  return root as unknown as IdentityPackageTree;
}
