import { describe, it, expect } from 'vitest';
import * as light from './index.js';

/**
 * Desacople de empaquetado (ADR-024 §9): el barrel LIVIANO (`@veo/policy`) expone SOLO el contrato (tipos,
 * catálogo, interfaz `PolicyReader`, tokens) — el cliente runtime cacheado (Kafka/rpc/Nest) vive en el
 * subpath `@veo/policy/nest`. Este spec importa únicamente el barrel liviano: si arrastrara el runtime,
 * `KafkaCachedPolicyReader`/`PolicyModule` aparecerían acá. `@veo/auth`, además, NO importa `@veo/policy`
 * (su guard usa `POLICY_READER_PORT` propio) → sin ciclo; eso lo cubre `pnpm --filter @veo/auth typecheck`.
 */
describe('empaquetado @veo/policy — el export liviano no arrastra el runtime', () => {
  it('el barrel liviano NO expone el cliente runtime ni el módulo Nest', () => {
    const keys = Object.keys(light);
    expect(keys).not.toContain('KafkaCachedPolicyReader');
    expect(keys).not.toContain('PolicyModule');
    expect(keys).not.toContain('PolicyUpdatedConsumer');
    expect(keys).not.toContain('InternalRestPolicyRegistry');
  });

  it('el liviano SÍ expone el contrato: interfaz por defecto, catálogo, helpers y el token', () => {
    expect(light.DefaultPolicyReader).toBeTypeOf('function');
    expect(light.POLICY_CATALOG).toBeDefined();
    expect(light.getPolicyDef).toBeTypeOf('function');
    expect(light.POLICY_READER).toBeTypeOf('symbol');
  });
});
