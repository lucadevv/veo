/**
 * Validación del DTO de creación de viaje en el borde (public-bff). Foco: el TECHO del bid
 * (`@Max(BID_MAX_CENTS)`) — primera barrera anti-abuso/anti-overflow int4 antes de llegar a
 * trip-service. El rango válido [piso..techo] debe seguir pasando; un bid desbocado debe romper.
 */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BID_MAX_CENTS } from '@veo/utils';
import { PaymentMethod } from '@veo/shared-types';
import { CreateTripDto } from './trip.dto';

const base = {
  origin: { lat: -12.0464, lon: -77.0428 },
  destination: { lat: -12.05, lon: -77.05 },
  paymentMethod: PaymentMethod.CASH,
};

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateTripDto, payload);
  return validate(dto, { whitelist: true });
}

describe('CreateTripDto.bidCents — techo del bid (@Max)', () => {
  it('rechaza un bid por encima del techo (BID_MAX_CENTS)', async () => {
    const errors = await errorsFor({ ...base, bidCents: 9_999_999_999 });
    const bidError = errors.find((e) => e.property === 'bidCents');
    expect(bidError).toBeDefined();
    expect(bidError?.constraints).toHaveProperty('max');
  });

  it('acepta un bid exactamente en el techo (BID_MAX_CENTS)', async () => {
    const errors = await errorsFor({ ...base, bidCents: BID_MAX_CENTS });
    expect(errors.find((e) => e.property === 'bidCents')).toBeUndefined();
  });

  it('acepta un bid dentro del rango válido (piso..techo)', async () => {
    const errors = await errorsFor({ ...base, bidCents: 900 });
    expect(errors.find((e) => e.property === 'bidCents')).toBeUndefined();
  });

  it('omitir bidCents es válido (camino de tarifa fija)', async () => {
    const errors = await errorsFor({ ...base });
    expect(errors.find((e) => e.property === 'bidCents')).toBeUndefined();
  });
});
