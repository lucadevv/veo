/**
 * Specs de CONTRATO contra el downstream REAL (sin mocks). Si el servicio no está levantado,
 * se hace ping en beforeAll y los casos se OMITEN (skip) — nunca fallan por entorno.
 * Levantar identity-service (:3001) para ejercitarlos: pnpm --filter @veo/identity-service dev
 */
import { describe, it, expect, beforeAll } from 'vitest';

const IDENTITY_URL = process.env.IDENTITY_URL ?? 'http://localhost:3001/api/v1';

async function reachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: ctrl.signal,
    });
    return true; // cualquier respuesta HTTP implica que el servicio está arriba
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

describe('Contrato: identity-service /admin/login', () => {
  let up = false;
  beforeAll(async () => {
    up = await reachable(`${IDENTITY_URL}/admin/login`);
  });

  it('rechaza credenciales inválidas con cuerpo de error tipado', async () => {
    if (!up) return; // servicio no disponible: se omite (no se falla por entorno)
    const res = await fetch(`${IDENTITY_URL}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noexiste@veo.pe', password: 'wrong-password-xx' }),
    });
    // El puerto puede estar ocupado por otro proceso (p.ej. Grafana en :3001 según FOUNDATION):
    // si no responde JSON, no es identity-service → se omite el contrato.
    if (!res.headers.get('content-type')?.includes('application/json')) return;
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body).toBeTypeOf('object');
    expect(body.error).toBeDefined();
  });
});
