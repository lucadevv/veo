import { describe, expect, it } from 'vitest';
import { generateReferralCode, normalizeReferralCode } from './referral-code';

describe('referral-code', () => {
  it('genera códigos de 8 chars del alfabeto seguro (sin 0/O/1/I/L)', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('genera códigos distintos (alta entropía)', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateReferralCode()));
    expect(set.size).toBeGreaterThan(195); // colisiones casi nulas
  });

  it('normaliza a mayúsculas y sin espacios', () => {
    expect(normalizeReferralCode('  ab cd ef ')).toBe('ABCDEF');
  });
});
