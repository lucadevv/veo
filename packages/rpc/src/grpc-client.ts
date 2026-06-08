/**
 * Factoría de clientes gRPC para lecturas BFF→servicio. Promisifica los métodos unarios
 * y añade deadline por defecto. Sin estado global: un cliente por servicio, reutilizable.
 */
import { credentials, loadPackageDefinition, Metadata, type Client } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  protoPathFor,
  SERVICE_PACKAGE,
  SERVICE_RPC_NAME,
  type ServiceName,
} from './proto-paths.js';

export interface GrpcClientOptions {
  /** host:port del servidor gRPC, ej. localhost:50052 */
  url: string;
  /** Deadline por llamada en ms (default 5000). */
  deadlineMs?: number;
}

type UnaryFn = (
  req: unknown,
  metadata: Metadata,
  options: { deadline: number },
  cb: (err: unknown, res: unknown) => void,
) => void;

/** Cliente gRPC con métodos promisificados: `await client.call('GetTrip', { id })`. */
export class GrpcServiceClient {
  private readonly raw: Client & Record<string, UnaryFn>;
  private readonly deadlineMs: number;

  constructor(service: ServiceName, opts: GrpcClientOptions) {
    const def = loadSync(protoPathFor(service), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as Record<string, unknown>;
    const ctor = resolvePath(pkg, `${SERVICE_PACKAGE[service]}.${SERVICE_RPC_NAME[service]}`);
    if (typeof ctor !== 'function') {
      throw new Error(`gRPC service ctor no encontrado para ${service}`);
    }
    const ClientCtor = ctor as new (url: string, creds: ReturnType<typeof credentials.createInsecure>) => Client;
    this.raw = new ClientCtor(opts.url, credentials.createInsecure()) as Client & Record<string, UnaryFn>;
    this.deadlineMs = opts.deadlineMs ?? 5000;
  }

  call<TRes = unknown>(method: string, request: Record<string, unknown>, meta?: Record<string, string>): Promise<TRes> {
    const fn = this.raw[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`método gRPC desconocido: ${method}`));
    }
    const metadata = new Metadata();
    if (meta) for (const [k, v] of Object.entries(meta)) metadata.set(k, v);
    const deadline = Date.now() + this.deadlineMs;
    return new Promise<TRes>((resolve, reject) => {
      fn.call(this.raw, request, metadata, { deadline }, (err: unknown, res: unknown) => {
        if (err) {
          reject(
            err instanceof Error
              ? err
              : new Error(typeof err === 'string' ? err : `gRPC error: ${JSON.stringify(err)}`),
          );
        } else resolve(res as TRes);
      });
    });
  }

  close(): void {
    (this.raw as unknown as { close: () => void }).close();
  }
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function createGrpcClient(service: ServiceName, opts: GrpcClientOptions): GrpcServiceClient {
  return new GrpcServiceClient(service, opts);
}
