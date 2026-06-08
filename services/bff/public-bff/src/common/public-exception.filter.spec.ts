/**
 * PublicExceptionFilter — modelo de error público uniforme. Cubre el contrato CRÍTICO de propagación:
 *  - DownstreamError 5xx → se APLASTA a 502 UPSTREAM_UNAVAILABLE (oculta internals, reintentable).
 *  - DownstreamError 422 GATEWAY_CAPABILITY_UNAVAILABLE → propaga LIMPIO (code+status+details intactos),
 *    para que la app distinga la degradación honesta (capacidad no habilitada, NO reintentable) del
 *    "servicio ocupado" transitorio (UPSTREAM). 422 < 500 NO se aplasta.
 */
import { describe, it, expect, vi } from 'vitest';
import { DownstreamError } from '@veo/rpc';
import { GatewayCapabilityUnavailableError } from '@veo/utils';
import { PublicExceptionFilter } from './public-exception.filter';

interface Captured {
  status: number;
  body: { error: { code: string; message: string; details?: Record<string, unknown> } };
}

/** Host mínimo de Nest: captura status + json del filtro sin levantar HTTP. */
function runFilter(exception: unknown): Captured {
  const captured = {} as Captured;
  const res = {
    status(code: number) {
      captured.status = code;
      return { json(body: unknown) { captured.body = body as Captured['body']; } };
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', url: '/payments/affiliations/yape' }),
    }),
  } as unknown as Parameters<PublicExceptionFilter['catch']>[1];

  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof PublicExceptionFilter>[0];
  new PublicExceptionFilter(logger).catch(exception, host);
  return captured;
}

describe('PublicExceptionFilter', () => {
  it('DownstreamError 5xx → 502 UPSTREAM_UNAVAILABLE (aplastado, reintentable)', () => {
    const out = runFilter(new DownstreamError(503, 'EXTERNAL', 'proveedor caído', { secret: 'x' }));
    expect(out.status).toBe(502);
    expect(out.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    // No filtra internals del 5xx.
    expect(out.body.error.details).toBeUndefined();
  });

  it('DownstreamError 422 GATEWAY_CAPABILITY_UNAVAILABLE → propaga LIMPIO (code+status+details)', () => {
    const out = runFilter(
      new DownstreamError(422, 'GATEWAY_CAPABILITY_UNAVAILABLE', 'capacidad no habilitada', {
        capability: 'YAPE_ON_FILE',
      }),
    );
    expect(out.status).toBe(422); // NO se aplasta a 502
    expect(out.body.error.code).toBe('GATEWAY_CAPABILITY_UNAVAILABLE');
    expect(out.body.error.details).toEqual({ capability: 'YAPE_ON_FILE' });
  });

  it('DomainError GatewayCapabilityUnavailableError local → 422 con su code y details', () => {
    const out = runFilter(
      new GatewayCapabilityUnavailableError('cap no habilitada', { capability: 'YAPE_ON_FILE' }),
    );
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('GATEWAY_CAPABILITY_UNAVAILABLE');
    expect(out.body.error.details).toEqual({ capability: 'YAPE_ON_FILE' });
  });

  it('DownstreamError 409 INVALID_STATE (sandbox puro) NO se confunde con capability: propaga 409 propio', () => {
    const out = runFilter(new DownstreamError(409, 'INVALID_STATE', 'transición inválida'));
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('INVALID_STATE');
  });
});
