import { planForChallenge } from '../index';

describe('planForChallenge', () => {
  it('deriva más frames para acciones dinámicas (parpadeo/asentir)', () => {
    expect(planForChallenge('BLINK').frameCount).toBe(12);
    expect(planForChallenge('NOD').frameCount).toBe(12);
  });

  it('usa el conteo por defecto para acciones no mapeadas', () => {
    const plan = planForChallenge('UNKNOWN_ACTION');
    expect(plan.frameCount).toBe(10);
    expect(plan.intervalMs).toBe(100);
  });

  it('normaliza la acción (espacios/mayúsculas) y conserva el original', () => {
    const plan = planForChallenge('  turn_left ');
    expect(plan.frameCount).toBe(10);
    expect(plan.action).toBe('  turn_left ');
  });
});
