import { describe, it, expect } from 'vitest';
import { ipInCidr, ipInAnyCidr } from './cidr';

describe('ipInCidr (IPv4)', () => {
  it('matchea una IP dentro del rango /24', () => {
    expect(ipInCidr('192.168.1.42', '192.168.1.0/24')).toBe(true);
  });

  it('NO matchea una IP fuera del rango /24', () => {
    expect(ipInCidr('192.168.2.42', '192.168.1.0/24')).toBe(false);
  });

  it('matchea el /8', () => {
    expect(ipInCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
  });

  it('IP pelada = match exacto (/32)', () => {
    expect(ipInCidr('203.0.113.5', '203.0.113.5')).toBe(true);
    expect(ipInCidr('203.0.113.6', '203.0.113.5')).toBe(false);
  });

  it('/0 matchea cualquier IPv4', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('rechaza IP/CIDR malformados sin lanzar', () => {
    expect(ipInCidr('999.1.1.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipInCidr('no-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', 'basura')).toBe(false);
  });
});

describe('ipInCidr (IPv6)', () => {
  it('matchea dentro de un /32', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('maneja `::` comprimido y match exacto', () => {
    expect(ipInCidr('::1', '::1')).toBe(true);
    expect(ipInCidr('::1', '::2')).toBe(false);
    expect(ipInCidr('fe80::abcd', 'fe80::/16')).toBe(true);
  });

  it('/0 matchea cualquier IPv6', () => {
    expect(ipInCidr('2001:db8::1', '::/0')).toBe(true);
  });

  it('quita el zone-id', () => {
    expect(ipInCidr('fe80::1%eth0', 'fe80::/16')).toBe(true);
  });
});

describe('ipInCidr (IPv4-mapped IPv6)', () => {
  it('normaliza `::ffff:a.b.c.d` a IPv4 y matchea un CIDR IPv4', () => {
    expect(ipInCidr('::ffff:192.168.1.42', '192.168.1.0/24')).toBe(true);
    expect(ipInCidr('::ffff:192.168.2.42', '192.168.1.0/24')).toBe(false);
  });

  it('un CIDR pelado en forma mapeada matchea el mismo IPv4 (ambos normalizan a v4)', () => {
    expect(ipInCidr('192.168.1.42', '::ffff:192.168.1.42')).toBe(true);
    expect(ipInCidr('192.168.1.43', '::ffff:192.168.1.42')).toBe(false);
  });

  it('NO cruza familias: IPv6 real vs CIDR IPv4', () => {
    expect(ipInCidr('2001:db8::1', '192.168.1.0/24')).toBe(false);
  });
});

describe('ipInAnyCidr', () => {
  it('true si matchea al menos uno', () => {
    expect(ipInAnyCidr('10.1.2.3', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
  });
  it('false si no matchea ninguno', () => {
    expect(ipInAnyCidr('172.16.0.1', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(false);
  });
  it('lista vacía → false', () => {
    expect(ipInAnyCidr('10.1.2.3', [])).toBe(false);
  });
});
