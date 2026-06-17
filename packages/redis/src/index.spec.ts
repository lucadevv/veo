/**
 * Smoke test de la factory resiliente. SIN red: usa `lazyConnect` para que el cliente NO conecte
 * (status 'wait'), así verificamos el CONTRATO de resiliencia sin depender de un Redis arriba.
 * El comportamiento de conexión real ya está probado en vivo (payment-service) y por los 15 servicios
 * que consumen el factory; acá blindamos la config no-negociable y el handler de error.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRedisClient } from './index.js';

describe('createRedisClient — factory resiliente (sin red, lazyConnect)', () => {
  it('aplica la config no-negociable: maxRetriesPerRequest null + enableReadyCheck + retryStrategy con techo + keyPrefix', () => {
    const client = createRedisClient('redis://localhost:6379', { lazyConnect: true, keyPrefix: 'veo:test:' });
    try {
      expect(client.options.maxRetriesPerRequest).toBeNull(); // reintento indefinido (no mata el proceso)
      expect(client.options.enableReadyCheck).toBe(true);
      expect(client.options.keyPrefix).toBe('veo:test:');
      expect(client.status).toBe('wait'); // lazyConnect → no conecta hasta el primer comando

      const retry = client.options.retryStrategy;
      expect(typeof retry).toBe('function');
      expect(retry!(1)).toBe(200); // 1 * RETRY_BACKOFF_STEP_MS
      expect(retry!(10_000)).toBe(5_000); // capado al techo RETRY_BACKOFF_MAX_MS
    } finally {
      client.disconnect();
    }
  });

  it("engancha un handler de 'error' que LOGUEA sin relanzar (no tumba el proceso ante un blip)", () => {
    const logger = { warn: vi.fn() };
    const client = createRedisClient('redis://localhost:6379', { lazyConnect: true, logger });
    try {
      expect(client.listenerCount('error')).toBeGreaterThanOrEqual(1);
      // Emitir 'error' NO debe lanzar (el handler está presente) y debe loguear vía logger.warn.
      expect(() => client.emit('error', new Error('blip transitorio'))).not.toThrow();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blip transitorio'));
    } finally {
      client.disconnect();
    }
  });
});
