import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, topicForEvent, schemaForEvent } from './schemas.js';

const VALID = {
  payoutId: 'po-1',
  driverId: 'drv-1',
  amountCents: 4200,
  period: '2026-W26',
};

describe('payout money-OUT events (ADR-015 §4.1)', () => {
  describe('registro central', () => {
    it('payout.processing y payout.failed están registrados en EVENT_SCHEMAS', () => {
      expect(EVENT_SCHEMAS['payout.processing']).toBeDefined();
      expect(EVENT_SCHEMAS['payout.failed']).toBeDefined();
    });

    it('enrutan al topic payment (dominio antes del punto)', () => {
      expect(topicForEvent('payout.processing')).toBe('payout');
      expect(topicForEvent('payout.failed')).toBe('payout');
    });
  });

  describe('payout.processing', () => {
    it('ACEPTA un payload válido (IDs + monto + período)', () => {
      expect(schemaForEvent('payout.processing')!.safeParse(VALID).success).toBe(true);
    });

    it('RECHAZA un payload sin campos requeridos', () => {
      expect(
        schemaForEvent('payout.processing')!.safeParse({ payoutId: 'po-1' }).success,
      ).toBe(false);
    });

    it('FALLA-CERRADO contra PII: rechaza un campo extra (.strict)', () => {
      const withPii = { ...VALID, walletUid: 'wallet-secret', phone: '+51999000111' };
      expect(schemaForEvent('payout.processing')!.safeParse(withPii).success).toBe(false);
    });
  });

  describe('payout.failed', () => {
    it('ACEPTA un payload válido', () => {
      expect(schemaForEvent('payout.failed')!.safeParse(VALID).success).toBe(true);
    });

    it('RECHAZA amountCents no entero', () => {
      expect(
        schemaForEvent('payout.failed')!.safeParse({ ...VALID, amountCents: 42.5 }).success,
      ).toBe(false);
    });

    it('FALLA-CERRADO contra PII: rechaza un campo extra (.strict)', () => {
      const withPii = { ...VALID, driverName: 'Juan Perez' };
      expect(schemaForEvent('payout.failed')!.safeParse(withPii).success).toBe(false);
    });
  });
});
