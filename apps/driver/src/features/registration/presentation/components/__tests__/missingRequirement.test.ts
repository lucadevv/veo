import { firstMissingRequirement, type StepRequirement } from '../missingRequirement';

/**
 * U3 · `firstMissingRequirement` traduce el gating del paso a la clave i18n del PRIMER requisito incumplido
 * (o `null` si todos están satisfechos). El ORDEN del array ES la secuencia/prioridad de pasos.
 */
describe('firstMissingRequirement', () => {
  const reqs = (...satisfied: boolean[]): StepRequirement[] =>
    satisfied.map((s, i) => ({ satisfied: s, missingKey: `key.${i}` }));

  it('devuelve null cuando todos los requisitos están satisfechos', () => {
    expect(firstMissingRequirement(reqs(true, true, true))).toBeNull();
  });

  it('devuelve la clave del PRIMER requisito incumplido (respeta el orden/secuencia)', () => {
    expect(firstMissingRequirement(reqs(false, false, true))).toBe('key.0');
    expect(firstMissingRequirement(reqs(true, false, false))).toBe('key.1');
    expect(firstMissingRequirement(reqs(true, true, false))).toBe('key.2');
  });

  it('lista vacía → null (no hay nada que falte)', () => {
    expect(firstMissingRequirement([])).toBeNull();
  });
});
