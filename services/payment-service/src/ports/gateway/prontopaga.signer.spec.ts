import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSignBase, signPayload, withSignature, verifySignature } from './prontopaga.signer';

const SECRET = '01JNH2SBC5Z2CM1PWQXM2C1XK9'; // secretKey de prueba pública (docs/first-steps)

/**
 * Vectores armados a mano siguiendo el algoritmo de docs/sign-transactions:
 * claves (≠ sign) ordenadas alfabéticamente, concat `clave+valor` sin separador, HMAC-SHA256(secretKey).
 */
describe('buildSignBase · cadena a firmar (docs/sign-transactions)', () => {
  it('ordena las claves alfabéticamente y concatena clave+valor sin separador', () => {
    const base = buildSignBase({ currency: 'PEN', amount: '25.50', country: 'PE' });
    // orden alfabético: amount, country, currency
    expect(base).toBe('amount25.50countryPEcurrencyPEN');
  });

  it('excluye el campo `sign` de la cadena', () => {
    const base = buildSignBase({ amount: '10.00', sign: 'DEADBEEF', country: 'PE' });
    expect(base).toBe('amount10.00countryPE');
    expect(base).not.toContain('DEADBEEF');
  });

  it('omite valores undefined/null (no viajan en el JSON, no entran en la firma)', () => {
    const base = buildSignBase({
      amount: '10.00',
      walletUID: undefined,
      deepLink: null,
      country: 'PE',
    });
    expect(base).toBe('amount10.00countryPE');
  });
});

describe('signPayload · HMAC-SHA256 con secretKey', () => {
  it('coincide con el cálculo manual de referencia', () => {
    const payload = { amount: '25.50', country: 'PE', currency: 'PEN' };
    const expected = createHmac('sha256', SECRET)
      .update('amount25.50countryPEcurrencyPEN')
      .digest('hex');
    expect(signPayload(payload, SECRET)).toBe(expected);
  });

  it('es estable ante el orden de inserción de las claves', () => {
    const a = signPayload({ b: '2', a: '1', c: '3' }, SECRET);
    const b = signPayload({ c: '3', a: '1', b: '2' }, SECRET);
    expect(a).toBe(b);
  });

  it('cambia si cambia cualquier valor', () => {
    const a = signPayload({ amount: '25.50' }, SECRET);
    const b = signPayload({ amount: '25.51' }, SECRET);
    expect(a).not.toBe(b);
  });
});

describe('withSignature', () => {
  it('agrega el campo sign calculado sin mutar el resto', () => {
    const signed = withSignature({ amount: '10.00', country: 'PE' }, SECRET);
    expect(signed.amount).toBe('10.00');
    expect(signed.sign).toBe(signPayload({ amount: '10.00', country: 'PE' }, SECRET));
  });
});

describe('verifySignature · timing-safe', () => {
  it('acepta una firma válida', () => {
    const payload = { uid: 'abc', status: 'success', order: 'pay-1' };
    const sign = signPayload(payload, SECRET);
    expect(verifySignature(payload, SECRET, sign)).toBe(true);
  });

  it('rechaza una firma adulterada', () => {
    const payload = { uid: 'abc', status: 'success' };
    const sign = signPayload(payload, SECRET);
    const tampered = sign.slice(0, -1) + (sign.endsWith('0') ? '1' : '0');
    expect(verifySignature(payload, SECRET, tampered)).toBe(false);
  });

  it('rechaza si el payload fue manipulado tras firmar', () => {
    const sign = signPayload({ amount: '10.00' }, SECRET);
    expect(verifySignature({ amount: '999.00' }, SECRET, sign)).toBe(false);
  });

  it('rechaza firma ausente o de longitud distinta (sin lanzar)', () => {
    expect(verifySignature({ a: '1' }, SECRET, undefined)).toBe(false);
    expect(verifySignature({ a: '1' }, SECRET, 'short')).toBe(false);
  });
});
