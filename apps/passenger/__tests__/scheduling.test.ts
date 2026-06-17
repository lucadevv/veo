import {
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_LEAD_MS,
  validateScheduledFor,
} from '../src/features/trip/domain/scheduling';
import {
  scheduleDayOptions,
  TIME_SLOT_STEP_MIN,
  timeSlotsForDay,
} from '../src/features/trip/domain/scheduleSlots';

const NOW = new Date('2026-05-30T12:00:00.000Z');

describe('validateScheduledFor · ventana [≥15min, ≤7días]', () => {
  it('acepta una fecha a 30 minutos', () => {
    const target = new Date(NOW.getTime() + 30 * 60 * 1000);
    expect(validateScheduledFor(target, NOW)).toEqual({valid: true});
  });

  it('rechaza por debajo del mínimo de 15 minutos (TOO_SOON)', () => {
    const target = new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS - 60 * 1000);
    expect(validateScheduledFor(target, NOW)).toEqual({
      valid: false,
      reason: 'TOO_SOON',
    });
  });

  it('acepta justo en el borde del mínimo (15 min exactos)', () => {
    const target = new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS);
    expect(validateScheduledFor(target, NOW)).toEqual({valid: true});
  });

  it('rechaza más allá de 7 días (TOO_FAR)', () => {
    const target = new Date(
      NOW.getTime() + MAX_SCHEDULE_HORIZON_MS + 60 * 1000,
    );
    expect(validateScheduledFor(target, NOW)).toEqual({
      valid: false,
      reason: 'TOO_FAR',
    });
  });

  it('acepta justo en el borde de los 7 días', () => {
    const target = new Date(NOW.getTime() + MAX_SCHEDULE_HORIZON_MS);
    expect(validateScheduledFor(target, NOW)).toEqual({valid: true});
  });

  it('marca como inválida una fecha no parseable', () => {
    expect(validateScheduledFor(new Date('no-fecha'), NOW)).toEqual({
      valid: false,
      reason: 'INVALID',
    });
  });
});

describe('scheduleSlots · generación de días y horas válidas', () => {
  it('ofrece como mucho 8 días (hoy + 7) dentro de la ventana', () => {
    const days = scheduleDayOptions(NOW);
    expect(days.length).toBeGreaterThan(0);
    expect(days.length).toBeLessThanOrEqual(8);
  });

  it('cada horario ofrecido para hoy respeta la antelación mínima', () => {
    const todayStart = new Date(
      NOW.getFullYear(),
      NOW.getMonth(),
      NOW.getDate(),
    ).getTime();
    const slots = timeSlotsForDay(todayStart, NOW);
    const earliest = NOW.getTime() + MIN_SCHEDULE_LEAD_MS;
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(earliest);
      expect(validateScheduledFor(new Date(slot), NOW)).toEqual({valid: true});
    }
  });

  it('los horarios van en pasos de 15 minutos', () => {
    const todayStart = new Date(
      NOW.getFullYear(),
      NOW.getMonth(),
      NOW.getDate(),
    ).getTime();
    const slots = timeSlotsForDay(todayStart, NOW);
    expect(slots.length).toBeGreaterThan(1);
    expect(slots[1] - slots[0]).toBe(TIME_SLOT_STEP_MIN * 60 * 1000);
  });
});
