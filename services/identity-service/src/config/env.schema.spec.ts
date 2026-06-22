import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';

/**
 * Fail-fast de puertos por entorno (diferenciador de seguridad VEO): en un entorno PRODUCTIVO
 * (NODE_ENV=production, internet-facing) TODOS los puertos intercambiables (biométrico, OAuth, SMS, email)
 * DEBEN estar en `live`. En sandbox cada uno usa un sustituto inseguro (biometría decorativa, OAuth que
 * acepta id_token forjado, OTP en claro al log sin enviar SMS, emails solo logueados). En local/development
 * sandbox sigue permitido (dev/CI sin proveedores reales).
 */
describe('env.schema · gate de puertos por entorno (superRefine)', () => {
  // Mínimo de vars REQUERIDAS sin default para que el parse llegue al superRefine.
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/identity',
    ADMIN_WEB_URL: 'http://localhost:3000',
  };

  // Los 4 puertos en `live`: deja el entorno productivo válido salvo el modo que el test ponga en sandbox.
  const allLive = {
    VEO_BIOMETRIC_MODE: 'live',
    VEO_OAUTH_MODE: 'live',
    VEO_SMS_MODE: 'live',
    VEO_EMAIL_MODE: 'live',
  } as const;

  describe('biométrico', () => {
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
      const env = validateEnv({ ...base, NODE_ENV: 'production', ...allLive });
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

  describe('OAuth', () => {
    it('FALLA en productivo con modo sandbox (acepta id_token forjado → account takeover)', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', ...allLive, VEO_OAUTH_MODE: 'sandbox' }),
      ).toThrow(/VEO_OAUTH_MODE/);
    });

    it('FALLA en productivo con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
      // base solo trae VEO_BIOMETRIC_MODE/SMS/EMAIL en live; OAuth queda en su default sandbox.
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          VEO_BIOMETRIC_MODE: 'live',
          VEO_SMS_MODE: 'live',
          VEO_EMAIL_MODE: 'live',
        }),
      ).toThrow(/VEO_OAUTH_MODE/);
    });

    it('PASA en local/development con modo sandbox (dev/CI con fixtures)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_OAUTH_MODE: 'sandbox' });
      expect(env.VEO_OAUTH_MODE).toBe('sandbox');
    });
  });

  describe('SMS', () => {
    it('FALLA en productivo con modo sandbox (OTP en claro al log + login roto)', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', ...allLive, VEO_SMS_MODE: 'sandbox' }),
      ).toThrow(/VEO_SMS_MODE/);
    });

    it('FALLA en productivo con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          VEO_BIOMETRIC_MODE: 'live',
          VEO_OAUTH_MODE: 'live',
          VEO_EMAIL_MODE: 'live',
        }),
      ).toThrow(/VEO_SMS_MODE/);
    });

    it('PASA en local/development con modo sandbox (dev sin operador SMS)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_SMS_MODE: 'sandbox' });
      expect(env.VEO_SMS_MODE).toBe('sandbox');
    });
  });

  describe('email', () => {
    it('FALLA en productivo con modo sandbox (emails solo logueados, no se envían)', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', ...allLive, VEO_EMAIL_MODE: 'sandbox' }),
      ).toThrow(/VEO_EMAIL_MODE/);
    });

    it('FALLA en productivo con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          VEO_BIOMETRIC_MODE: 'live',
          VEO_OAUTH_MODE: 'live',
          VEO_SMS_MODE: 'live',
        }),
      ).toThrow(/VEO_EMAIL_MODE/);
    });

    it('PASA en local/development con modo sandbox (dev usa Mailpit/log)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_EMAIL_MODE: 'sandbox' });
      expect(env.VEO_EMAIL_MODE).toBe('sandbox');
    });
  });

  describe('los 4 puertos juntos', () => {
    it('PASA en productivo con los 4 modos en live', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'production', ...allLive });
      expect(env.VEO_BIOMETRIC_MODE).toBe('live');
      expect(env.VEO_OAUTH_MODE).toBe('live');
      expect(env.VEO_SMS_MODE).toBe('live');
      expect(env.VEO_EMAIL_MODE).toBe('live');
    });

    it('FALLA en productivo con TODO en default (sandbox) reportando los 4 modos', () => {
      try {
        validateEnv({ ...base, NODE_ENV: 'production' });
        throw new Error('debió lanzar');
      } catch (err) {
        const message = String(err);
        expect(message).toMatch(/VEO_BIOMETRIC_MODE/);
        expect(message).toMatch(/VEO_OAUTH_MODE/);
        expect(message).toMatch(/VEO_SMS_MODE/);
        expect(message).toMatch(/VEO_EMAIL_MODE/);
      }
    });
  });
});
