import { describe, it, expect } from 'vitest';
import { validateEnv, LIVE_MODE } from './env.schema';

/**
 * Fail-fast de puertos por entorno (diferenciador de seguridad VEO): en un entorno PRODUCTIVO
 * (NODE_ENV=production, internet-facing) el puerto SMS DEBE estar en `live`. En sandbox el sender NO
 * envía nada real (solo loguea el destino enmascarado): ni el OTP de verificación del contacto ni el
 * enlace de seguimiento que se manda al familiar en pánico llegarían. En local/development sandbox sigue
 * permitido (dev/CI sin gateway de operador).
 */
describe('env.schema · gate de puertos por entorno (superRefine)', () => {
  // Mínimo de vars REQUERIDAS sin default para que el parse llegue al superRefine.
  // SHARE_LINK_SECRET e INTERNAL_IDENTITY_SECRET usan secret() con default de dev (no requeridas acá).
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/share',
  };

  describe('SMS', () => {
    it('FALLA el arranque en entorno productivo con modo sandbox', () => {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', VEO_SMS_MODE: 'sandbox' }),
      ).toThrow(/VEO_SMS_MODE/);
    });

    it('FALLA en productivo aun con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
      // Sin VEO_SMS_MODE explícito: el default es sandbox, que en producción es inválido.
      expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/VEO_SMS_MODE/);
    });

    it('PASA en entorno productivo con modo live', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'production', VEO_SMS_MODE: LIVE_MODE });
      expect(env.VEO_SMS_MODE).toBe(LIVE_MODE);
    });

    it('PASA en local/development con modo sandbox (no rompe el dev)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_SMS_MODE: 'sandbox' });
      expect(env.VEO_SMS_MODE).toBe('sandbox');
    });

    it('PASA en test con modo sandbox (CI sin gateway de operador)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'test', VEO_SMS_MODE: 'sandbox' });
      expect(env.VEO_SMS_MODE).toBe('sandbox');
    });

    it('PASA en local/development con el DEFAULT (sandbox) — dev no necesita operador real', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development' });
      expect(env.VEO_SMS_MODE).toBe('sandbox');
    });
  });
});
