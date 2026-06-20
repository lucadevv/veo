import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';

/**
 * Fail-fast biométrico por entorno (diferenciador de seguridad VEO): en un entorno PRODUCTIVO
 * (NODE_ENV=production, internet-facing) el modo biométrico DEBE ser `live`. En sandbox el embedding es
 * sha256(photo) → la biometría sería decorativa. En local/development sandbox sigue permitido (dev/CI).
 */
describe('env.schema · gate biométrico por entorno (superRefine)', () => {
  // Mínimo de vars REQUERIDAS sin default para que el parse llegue al superRefine.
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/identity',
    ADMIN_WEB_URL: 'http://localhost:3000',
  };

  it('FALLA el arranque en entorno productivo con modo sandbox', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', VEO_BIOMETRIC_MODE: 'sandbox' }),
    ).toThrow(/VEO_BIOMETRIC_MODE/);
  });

  it('FALLA en productivo aun con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
    // Sin VEO_BIOMETRIC_MODE explícito: el default es sandbox, que en producción es inválido.
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/VEO_BIOMETRIC_MODE/);
  });

  it('PASA en entorno productivo con modo live', () => {
    const env = validateEnv({ ...base, NODE_ENV: 'production', VEO_BIOMETRIC_MODE: 'live' });
    expect(env.VEO_BIOMETRIC_MODE).toBe('live');
  });

  it('PASA en local/development con modo sandbox (no rompe el dev)', () => {
    const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_BIOMETRIC_MODE: 'sandbox' });
    expect(env.VEO_BIOMETRIC_MODE).toBe('sandbox');
  });

  it('PASA en test con modo sandbox (CI sin device ni ONNX)', () => {
    const env = validateEnv({ ...base, NODE_ENV: 'test', VEO_BIOMETRIC_MODE: 'sandbox' });
    expect(env.VEO_BIOMETRIC_MODE).toBe('sandbox');
  });
});
