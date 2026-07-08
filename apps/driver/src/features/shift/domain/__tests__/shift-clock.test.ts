import {
  formatShiftDurationLong,
  formatShiftDurationShort,
  shiftElapsedMinutes,
} from '../value-objects/shift-clock';

describe('shift-clock', () => {
  describe('shiftElapsedMinutes', () => {
    it('calcula los minutos entre inicio y ahora (piso)', () => {
      const start = 1_000_000;
      // 6 h 12 min 40 s → piso a 372 min
      expect(shiftElapsedMinutes(start, start + (372 * 60 + 40) * 1000)).toBe(372);
    });

    it('nunca es negativo si el reloj retrocede', () => {
      expect(shiftElapsedMinutes(2_000, 1_000)).toBe(0);
    });

    it('degrada a 0 con marcas no finitas', () => {
      expect(shiftElapsedMinutes(Number.NaN, Date.now())).toBe(0);
      expect(shiftElapsedMinutes(1000, Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe('formatShiftDurationLong', () => {
    it('muestra horas y minutos', () => {
      expect(formatShiftDurationLong(372)).toBe('6 h 12 min');
    });

    it('omite los minutos en una hora exacta', () => {
      expect(formatShiftDurationLong(120)).toBe('2 h');
    });

    it('muestra solo minutos por debajo de la hora', () => {
      expect(formatShiftDurationLong(45)).toBe('45 min');
      expect(formatShiftDurationLong(0)).toBe('0 min');
    });
  });

  describe('formatShiftDurationShort', () => {
    it('usa horas con un decimal a partir de 60 min', () => {
      expect(formatShiftDurationShort(372)).toBe('6.2 h');
      expect(formatShiftDurationShort(60)).toBe('1.0 h');
    });

    it('usa minutos por debajo de la hora', () => {
      expect(formatShiftDurationShort(45)).toBe('45 min');
    });
  });
});
