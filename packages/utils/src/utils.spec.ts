import { describe, it, expect } from 'vitest';
import { uuidv7, isUuidV7 } from './ids.js';
import { money, commission, formatPEN, solesToCents, scaleMoney } from './money.js';
import { signHmac, verifyHmac, chainHash, numericOtp } from './crypto.js';
import { toH3, distanceMeters, isWithinLima, neighbors } from './geo.js';
import {
  peruPhoneSchema,
  plateSchema,
  childCodeSchema,
  parseOrThrow,
  canonicalizePeruPhone,
} from './validation.js';
import { ValidationError } from './errors.js';
import { assertNever } from './assert.js';

describe('ids', () => {
  it('genera UUIDv7 válidos y ordenables por tiempo', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_001_000);
    expect(isUuidV7(a)).toBe(true);
    expect(isUuidV7(b)).toBe(true);
    expect(a < b).toBe(true); // ordenable lexicográficamente por timestamp
  });
});

describe('money', () => {
  it('opera en céntimos enteros', () => {
    expect(solesToCents(15)).toBe(1500);
    expect(formatPEN(1500)).toBe('S/ 15.00');
  });
  it('calcula comisión 20% (BR-P04)', () => {
    expect(commission(money(1500), 0.2).cents).toBe(300);
  });
  it('aplica surge multiplier (BR-T05)', () => {
    expect(scaleMoney(money(1000), 1.5).cents).toBe(1500);
  });
  it('rechaza céntimos no enteros', () => {
    expect(() => money(15.5)).toThrow(ValidationError);
  });
});

describe('crypto', () => {
  it('firma y verifica HMAC en tiempo constante', () => {
    const sig = signHmac('trip:123', 'secret');
    expect(verifyHmac('trip:123', 'secret', sig)).toBe(true);
    expect(verifyHmac('trip:123', 'secret', sig.replace(/.$/, '0'))).toBe(false);
  });
  it('encadena hashes para audit (tampering detectable)', () => {
    const h1 = chainHash(null, 'entry-1');
    const h2 = chainHash(h1, 'entry-2');
    expect(chainHash(h1, 'entry-2')).toBe(h2);
    expect(chainHash('tampered', 'entry-2')).not.toBe(h2);
  });
  it('genera OTP numérico del largo pedido', () => {
    expect(numericOtp(6)).toMatch(/^\d{6}$/);
  });
});

describe('geo (H3)', () => {
  it('indexa puntos de Lima y mide distancias', () => {
    const miraflores = { lat: -12.121, lon: -77.03 };
    const sanIsidro = { lat: -12.097, lon: -77.036 };
    expect(toH3(miraflores)).toHaveLength(15);
    expect(distanceMeters(miraflores, sanIsidro)).toBeGreaterThan(1000);
    expect(isWithinLima(miraflores)).toBe(true);
    expect(isWithinLima({ lat: -16.4, lon: -71.5 })).toBe(false); // Arequipa
    expect(neighbors(toH3(miraflores), 1)).toHaveLength(7);
  });
});

describe('assertNever (exhaustividad sin default silencioso)', () => {
  it('lanza ante una variante imprevista en runtime (no se traga el caso)', () => {
    expect(() => assertNever('inesperado' as never)).toThrow(
      'Variante no contemplada: "inesperado"',
    );
  });
  it('acepta un mensaje de contexto propio', () => {
    expect(() => assertNever(undefined as never, 'Flujo no contemplado')).toThrow(
      'Flujo no contemplado',
    );
  });
  it('hace exhaustivo un switch sobre una unión (compila solo si cubre todos los casos)', () => {
    type Flow = 'a' | 'b';
    const route = (f: Flow): number => {
      switch (f) {
        case 'a':
          return 1;
        case 'b':
          return 2;
        default:
          return assertNever(f);
      }
    };
    expect(route('a')).toBe(1);
    expect(route('b')).toBe(2);
  });
});

describe('validación dominio peruano', () => {
  it('normaliza teléfono peruano', () => {
    expect(parseOrThrow(peruPhoneSchema, '987654321')).toBe('+51987654321');
    expect(parseOrThrow(peruPhoneSchema, '+51 987 654 321')).toBe('+51987654321');
  });
  it('canonicalizePeruPhone colapsa las 3 representaciones a +51XXXXXXXXX (coincide con peruPhoneSchema)', () => {
    const canon = '+51987654321';
    // Las 3 formas que el DTO acepta para el MISMO número → UNA sola key.
    expect(canonicalizePeruPhone('987654321')).toBe(canon);
    expect(canonicalizePeruPhone('51987654321')).toBe(canon);
    expect(canonicalizePeruPhone('+51987654321')).toBe(canon);
    // Espacios/guiones se ignoran; coincide con la salida de peruPhoneSchema.
    expect(canonicalizePeruPhone('+51-987-654-321')).toBe(canon);
    expect(canonicalizePeruPhone('987654321')).toBe(parseOrThrow(peruPhoneSchema, '987654321'));
    // No-teléfono → null (el caller decide el fallback, no rompe).
    expect(canonicalizePeruPhone('not-a-phone')).toBeNull();
    expect(canonicalizePeruPhone('123')).toBeNull();
    expect(canonicalizePeruPhone('887654321')).toBeNull(); // no empieza en 9
  });
  it('valida placa y código de niño', () => {
    expect(parseOrThrow(plateSchema, 'abc-123')).toBe('ABC-123');
    expect(parseOrThrow(childCodeSchema, '4729')).toBe('4729');
    expect(() => parseOrThrow(childCodeSchema, '12')).toThrow(ValidationError);
  });
  it('acepta placa de AUTO (ABC-123) y de MOTO (7351-NB), rechaza basura', () => {
    expect(parseOrThrow(plateSchema, 'ABC-123')).toBe('ABC-123');
    expect(parseOrThrow(plateSchema, 'A1B-234')).toBe('A1B-234');
    // Moto/vehículo menor (categoría L): 4 dígitos + 2 letras (placa real de una KTM).
    expect(parseOrThrow(plateSchema, '7351-NB')).toBe('7351-NB');
    expect(parseOrThrow(plateSchema, '123-AB')).toBe('123-AB');
    // Guion opcional y minúsculas (la placa se normaliza a mayúsculas).
    expect(parseOrThrow(plateSchema, '7351nb')).toBe('7351NB');
    expect(() => parseOrThrow(plateSchema, '12-3')).toThrow(ValidationError);
    expect(() => parseOrThrow(plateSchema, 'AB-12')).toThrow(ValidationError);
  });
});
