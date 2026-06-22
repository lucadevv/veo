import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';
import { SmsProvider } from '../ports/sms/sms.port';
import { PushMode } from '../ports/push/push.port';

/**
 * Fail-fast de canales de entrega por entorno (diferenciador de seguridad VEO): en un entorno PRODUCTIVO
 * (NODE_ENV=production, internet-facing) TODOS los canales DEBEN apuntar a un proveedor REAL. En sandbox cada
 * canal solo loguea y NO entrega (SMS sandbox loguea el OTP en claro, email sandbox loguea el correo, push
 * sandbox no llega al device). En local/development sandbox sigue permitido (dev/CI sin proveedores reales).
 *
 * MATIZ: el canal SMS NO se gobierna por un modo live/sandbox sino por `SMS_PROVIDER` (la fuente ACTIVA que
 * resolveProvider lee primero). El flag legado VEO_SMS_MODE es código MUERTO cuando SMS_PROVIDER está definido
 * (lo que el gate exige en prod) → este schema NO lo valida a propósito.
 */
describe('env.schema · gate de canales de entrega por entorno (superRefine)', () => {
  // Mínimo de vars REQUERIDAS sin default para que el parse llegue al superRefine.
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/notification',
  };

  // Config productiva VÁLIDA: los 3 canales apuntan a proveedor real. Cada test sobrescribe el que rompe.
  const allLive = {
    SMS_PROVIDER: SmsProvider.Smpp,
    VEO_EMAIL_MODE: 'live',
    VEO_PUSH_MODE: PushMode.Live,
  } as const;

  describe('SMS_PROVIDER (fuente ACTIVA del canal SMS)', () => {
    it('FALLA en productivo si SMS_PROVIDER está AUSENTE (cae a sandbox en resolveProvider)', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          VEO_EMAIL_MODE: 'live',
          VEO_PUSH_MODE: PushMode.Live,
        }),
      ).toThrow(/SMS_PROVIDER/);
    });

    it('FALLA en productivo si SMS_PROVIDER=sandbox (explícito → solo loguea el OTP)', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          ...allLive,
          SMS_PROVIDER: SmsProvider.Sandbox,
        }),
      ).toThrow(/SMS_PROVIDER/);
    });

    it('PASA en productivo con SMS_PROVIDER=smpp (proveedor real)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'production', ...allLive });
      expect(env.SMS_PROVIDER).toBe(SmsProvider.Smpp);
    });

    it('PASA en productivo con SMS_PROVIDER=twilio (proveedor real)', () => {
      const env = validateEnv({
        ...base,
        NODE_ENV: 'production',
        ...allLive,
        SMS_PROVIDER: SmsProvider.Twilio,
      });
      expect(env.SMS_PROVIDER).toBe(SmsProvider.Twilio);
    });

    it('PASA en development con SMS_PROVIDER ausente (dev sin operador SMS)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development' });
      expect(env.SMS_PROVIDER).toBeUndefined();
    });
  });

  describe('VEO_EMAIL_MODE', () => {
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
          SMS_PROVIDER: SmsProvider.Smpp,
          VEO_PUSH_MODE: PushMode.Live,
        }),
      ).toThrow(/VEO_EMAIL_MODE/);
    });

    it('PASA en development con modo sandbox (dev usa Mailpit/log)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_EMAIL_MODE: 'sandbox' });
      expect(env.VEO_EMAIL_MODE).toBe('sandbox');
    });
  });

  describe('VEO_PUSH_MODE', () => {
    it('FALLA en productivo con modo sandbox (no entrega push reales FCM/APNs)', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          ...allLive,
          VEO_PUSH_MODE: PushMode.Sandbox,
        }),
      ).toThrow(/VEO_PUSH_MODE/);
    });

    it('FALLA en productivo con el DEFAULT (sandbox) — el default inseguro no se cuela', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          SMS_PROVIDER: SmsProvider.Smpp,
          VEO_EMAIL_MODE: 'live',
        }),
      ).toThrow(/VEO_PUSH_MODE/);
    });

    it('PASA en development con modo sandbox (dev sin FCM/APNs)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development', VEO_PUSH_MODE: PushMode.Sandbox });
      expect(env.VEO_PUSH_MODE).toBe(PushMode.Sandbox);
    });
  });

  describe('VEO_SMS_MODE (flag legado MUERTO — NO se valida a propósito)', () => {
    it('PASA en productivo con VEO_SMS_MODE=sandbox si SMS_PROVIDER es real (el legado no decide)', () => {
      // resolveProvider lee SMS_PROVIDER primero; VEO_SMS_MODE jamás se evalúa. Validarlo sería un fantasma.
      const env = validateEnv({
        ...base,
        NODE_ENV: 'production',
        ...allLive,
        VEO_SMS_MODE: 'sandbox',
      });
      expect(env.VEO_SMS_MODE).toBe('sandbox');
      expect(env.SMS_PROVIDER).toBe(SmsProvider.Smpp);
    });
  });

  describe('entorno NO productivo', () => {
    it('PASA en development con TODOS los defaults (sandbox) — no rompe el dev', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development' });
      expect(env.VEO_EMAIL_MODE).toBe('sandbox');
      expect(env.VEO_PUSH_MODE).toBe(PushMode.Sandbox);
      expect(env.SMS_PROVIDER).toBeUndefined();
    });

    it('PASA en test con TODOS los defaults (CI sin proveedores reales)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'test' });
      expect(env.VEO_EMAIL_MODE).toBe('sandbox');
      expect(env.VEO_PUSH_MODE).toBe(PushMode.Sandbox);
    });
  });

  describe('los 3 canales juntos', () => {
    it('PASA en productivo con los 3 canales en proveedor real', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'production', ...allLive });
      expect(env.SMS_PROVIDER).toBe(SmsProvider.Smpp);
      expect(env.VEO_EMAIL_MODE).toBe('live');
      expect(env.VEO_PUSH_MODE).toBe(PushMode.Live);
    });

    it('FALLA en productivo con TODO en default reportando los 3 canales', () => {
      try {
        validateEnv({ ...base, NODE_ENV: 'production' });
        throw new Error('debió lanzar');
      } catch (err) {
        const message = String(err);
        expect(message).toMatch(/SMS_PROVIDER/);
        expect(message).toMatch(/VEO_EMAIL_MODE/);
        expect(message).toMatch(/VEO_PUSH_MODE/);
      }
    });
  });
});
