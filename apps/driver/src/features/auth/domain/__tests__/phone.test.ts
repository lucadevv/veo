import {isValidPeruPhone, normalizePeruPhone} from '../value-objects/phone';

describe('phone value-object', () => {
  it('normaliza variantes comunes a +519XXXXXXXX', () => {
    expect(normalizePeruPhone('987654321')).toBe('+51987654321');
    expect(normalizePeruPhone('51987654321')).toBe('+51987654321');
    expect(normalizePeruPhone('+51 987 654 321')).toBe('+51987654321');
    expect(normalizePeruPhone('+51-987-654-321')).toBe('+51987654321');
  });

  it('valida solo móviles peruanos (empiezan en 9, 9 dígitos)', () => {
    expect(isValidPeruPhone('987654321')).toBe(true);
    expect(isValidPeruPhone('+51987654321')).toBe(true);
    expect(isValidPeruPhone('12345678')).toBe(false);
    expect(isValidPeruPhone('887654321')).toBe(false);
    expect(isValidPeruPhone('98765432')).toBe(false);
  });
});
