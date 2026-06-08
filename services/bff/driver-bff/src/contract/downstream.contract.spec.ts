/**
 * Specs de CONTRATO contra los microservicios REALES (sin mocks).
 * Estrategia: en beforeAll se hace ping a la salud de cada servicio; si no responde, el test se
 * OMITE (ctx.skip) en lugar de fallar. Así el contrato se valida cuando el dev-stack está arriba
 * y no rompe CI cuando no lo está.
 */
import { describe, it, expect, beforeAll } from 'vitest';

/** En esta versión de vitest el método de skip dinámico no está tipado en TestContext. */
interface SkippableContext {
  skip: () => void;
}
import { GrpcGateway } from '../infra/grpc.gateway';
import type { AuthenticatedUser } from '@veo/auth';
import { uuidv7 } from '@veo/utils';
import type { SurgeReply, UserReply } from '../common/grpc-replies';

const ENV: Record<string, string> = {
  IDENTITY_GRPC_URL: process.env.IDENTITY_GRPC_URL ?? 'localhost:50051',
  DISPATCH_GRPC_URL: process.env.DISPATCH_GRPC_URL ?? 'localhost:50053',
};
const IDENTITY_URL = process.env.IDENTITY_URL ?? 'http://localhost:3001';
const DISPATCH_URL = process.env.DISPATCH_URL ?? 'http://localhost:3003';
const SECRET = process.env.VEO_INTERNAL_IDENTITY_SECRET ?? 'dev-internal-secret-change-me';

const configStub = { getOrThrow: (key: string): string => ENV[key] ?? '' };
const identity: AuthenticatedUser = { userId: uuidv7(), type: 'driver', roles: [], sessionId: 'contract' };

async function ping(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let identityUp = false;
let dispatchUp = false;

beforeAll(async () => {
  [identityUp, dispatchUp] = await Promise.all([ping(IDENTITY_URL), ping(DISPATCH_URL)]);
});

describe('contrato downstream (gRPC lecturas)', () => {
  it('identity GetUser responde con la forma UserReply', async (ctx) => {
    if (!identityUp) (ctx as unknown as SkippableContext).skip();
    const grpc = new GrpcGateway(configStub as never, SECRET);
    const reply = await grpc.call<UserReply>('identity', 'GetUser', { id: uuidv7() }, identity);
    expect(reply).toHaveProperty('found');
    expect(typeof reply.found).toBe('boolean');
  });

  it('dispatch GetSurge responde con la forma SurgeReply', async (ctx) => {
    if (!dispatchUp) (ctx as unknown as SkippableContext).skip();
    const grpc = new GrpcGateway(configStub as never, SECRET);
    const reply = await grpc.call<SurgeReply>(
      'dispatch',
      'GetSurge',
      { lat: -12.0464, lon: -77.0428 },
      identity,
    );
    expect(typeof reply.multiplier).toBe('number');
    expect(typeof reply.active).toBe('boolean');
  });

  it('los .proto requeridos se resuelven por @veo/rpc (sin servicios arriba)', () => {
    const grpc = new GrpcGateway(configStub as never, SECRET);
    expect(grpc).toBeInstanceOf(GrpcGateway);
  });
});
