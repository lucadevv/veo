import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBookingDto } from './create-booking.dto';

/**
 * Validación del CreateBookingDto. Foco: el `@Max` de `specialRequest` corta en validación (400) el
 * overflow del Int de Postgres en `precioAcordado = precioBase + specialRequest` ANTES de que llegue a 500.
 * Tope de dominio: S/100.000 = 100_000_00 céntimos (muy por debajo de 2^31 ≈ S/21.4M).
 */
const SPECIAL_REQUEST_MAX = 100_000_00;

const VALID_BASE = {
  publishedTripId: '11111111-1111-4111-8111-111111111111',
  asientos: 1,
  pickupLat: -12.0464,
  pickupLon: -77.0428,
  dropoffLat: -12.05,
  dropoffLon: -77.05,
};

function validate(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(CreateBookingDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

describe('CreateBookingDto · specialRequest @Max', () => {
  it('acepta un specialRequest en el tope de dominio (= S/100.000 en céntimos)', () => {
    const errors = validate({ ...VALID_BASE, specialRequest: SPECIAL_REQUEST_MAX });
    expect(errors).toHaveLength(0);
  });

  it('rechaza un specialRequest por encima del tope (corta el overflow Int en 400, no en 500)', () => {
    const errors = validate({ ...VALID_BASE, specialRequest: SPECIAL_REQUEST_MAX + 1 });
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error?.property).toBe('specialRequest');
    expect(error?.constraints).toHaveProperty('max');
  });

  it('rechaza un specialRequest cercano a 2^31 (el caso que overflowearía el Int de Postgres)', () => {
    const errors = validate({ ...VALID_BASE, specialRequest: 2 ** 31 - 1 });
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error?.property).toBe('specialRequest');
    expect(error?.constraints).toHaveProperty('max');
  });

  it('acepta el payload sin specialRequest (es opcional)', () => {
    const errors = validate({ ...VALID_BASE });
    expect(errors).toHaveLength(0);
  });
});
