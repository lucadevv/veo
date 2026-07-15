import { describe, it, expect } from 'vitest';
import { parseTrustedProxy } from './env.js';
import { ValidationError } from './errors.js';

describe('parseTrustedProxy', () => {
  it('parsea el preset de rangos privados del VPC a un arreglo de presets', () => {
    // El default de los BFFs: ALB + ingress-nginx (IP privada) son de confianza; el cliente público no.
    expect(parseTrustedProxy('loopback, linklocal, uniquelocal')).toEqual([
      'loopback',
      'linklocal',
      'uniquelocal',
    ]);
  });

  it('soporta subredes CIDR mezcladas con presets', () => {
    expect(parseTrustedProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
  });

  it('false (trust-none) se devuelve como boolean — válido y seguro (req.ip = peer TCP)', () => {
    expect(parseTrustedProxy('false')).toBe(false);
  });

  it('SEGURIDAD: RECHAZA trust-all (true) — req.ip sería el XFF crudo spoofeable', () => {
    expect(() => parseTrustedProxy('true')).toThrow(ValidationError);
    expect(() => parseTrustedProxy('true')).toThrow(/trust-all/i);
  });

  it("SEGURIDAD: RECHAZA trust-all expresado como '*'", () => {
    expect(() => parseTrustedProxy('*')).toThrow(ValidationError);
  });

  it('SEGURIDAD: RECHAZA trust-all aunque venga mezclado en un CSV con presets válidos', () => {
    // No basta con filtrarlo: si UN token es trust-all el operador pidió algo inseguro → fail-fast.
    expect(() => parseTrustedProxy('loopback, true, uniquelocal')).toThrow(ValidationError);
    expect(() => parseTrustedProxy('10.0.0.0/16, *')).toThrow(ValidationError);
  });

  it('un único token numérico se devuelve como number (cantidad de hops)', () => {
    expect(parseTrustedProxy('2')).toBe(2);
  });

  it('un único preset se devuelve como string escalar', () => {
    expect(parseTrustedProxy('uniquelocal')).toBe('uniquelocal');
  });

  it('un único CIDR acotado del VPC se devuelve como string escalar', () => {
    expect(parseTrustedProxy('10.0.0.0/16')).toBe('10.0.0.0/16');
  });

  it('descarta espacios y tokens vacíos', () => {
    expect(parseTrustedProxy(' loopback ,, linklocal , ')).toEqual(['loopback', 'linklocal']);
  });
});
