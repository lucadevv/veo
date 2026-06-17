import {isValidPeruPhone, normalizePeruPhone} from '../src/shared/utils/phone';

describe('normalizePeruPhone', () => {
  it('antepone 51 a un número local de 9 dígitos', () => {
    expect(normalizePeruPhone('987654321')).toBe('51987654321');
    expect(normalizePeruPhone('9 8765 4321')).toBe('51987654321');
  });

  it('conserva el prefijo +51 ya presente', () => {
    expect(normalizePeruPhone('+51 987 654 321')).toBe('+51987654321');
    expect(normalizePeruPhone('51987654321')).toBe('51987654321');
  });
});

describe('isValidPeruPhone', () => {
  it('acepta formatos local e internacional', () => {
    expect(isValidPeruPhone('987654321')).toBe(true);
    expect(isValidPeruPhone('+51987654321')).toBe(true);
    expect(isValidPeruPhone('51987654321')).toBe(true);
  });

  it('rechaza números incompletos o que no empiezan en 9', () => {
    expect(isValidPeruPhone('123')).toBe(false);
    expect(isValidPeruPhone('5187654321')).toBe(false);
  });
});
