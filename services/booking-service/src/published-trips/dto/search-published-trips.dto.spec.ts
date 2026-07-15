import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SearchPublishedTripsDto } from './search-published-trips.dto';

/**
 * Validación de BORDE del SearchPublishedTripsDto (F2 · GET /published-trips/search · public-rail anónimo).
 * Los query params llegan como STRING → `@Type(() => Number)` los coacciona antes de validar geo/Int. La
 * ruta (origen + destino) y la fecha son REQUERIDAS; asientos Int ≥ 1; limit acotado por @Max(50).
 */
const VALID_BASE: Record<string, unknown> = {
  originLat: '-12.0464', // como string (query param) → coaccionado a number
  originLon: '-77.0428',
  destLat: '-12.12',
  destLon: '-77.03',
  fecha: '2099-01-01', // FIX 2·F2: fecha-calendario PURA YYYY-MM-DD (sin hora ni offset)
  asientos: '2',
};

function validate(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(SearchPublishedTripsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

describe('SearchPublishedTripsDto · borde', () => {
  it('acepta una búsqueda válida (coacciona strings de query a number)', () => {
    const dto = plainToInstance(SearchPublishedTripsDto, VALID_BASE);
    expect(validate(VALID_BASE)).toHaveLength(0);
    expect(typeof dto.originLat).toBe('number');
    expect(dto.asientos).toBe(2);
  });

  it('rechaza si falta la fecha (requerida)', () => {
    const { fecha: _omit, ...sinFecha } = VALID_BASE;
    const errors = validate(sinFecha);
    expect(errors.some((e) => e.property === 'fecha')).toBe(true);
  });

  it('FIX 2·F2: acepta una fecha-calendario PURA YYYY-MM-DD', () => {
    const errors = validate({ ...VALID_BASE, fecha: '2026-06-25' });
    expect(errors.some((e) => e.property === 'fecha')).toBe(false);
  });

  it('FIX 2·F2: RECHAZA datetime con offset (no manipulable: la zona la pone el service, no el cliente)', () => {
    const errors = validate({ ...VALID_BASE, fecha: '2026-06-25T10:30:00-05:00' });
    expect(errors.some((e) => e.property === 'fecha')).toBe(true);
  });

  it('FIX 2·F2: RECHAZA datetime UTC (con T y Z) — solo el día calendario crudo pasa', () => {
    const errors = validate({ ...VALID_BASE, fecha: '2026-06-25T00:00:00.000Z' });
    expect(errors.some((e) => e.property === 'fecha')).toBe(true);
  });

  it('FIX 2·F2: RECHAZA una fecha mal formada / inexistente (2026-13-40)', () => {
    const errors = validate({ ...VALID_BASE, fecha: '2026-13-40' });
    expect(errors.some((e) => e.property === 'fecha')).toBe(true);
  });

  it('rechaza si falta el destino (la ruta es A→B, ambos extremos requeridos)', () => {
    const { destLat: _omit, ...sinDest } = VALID_BASE;
    const errors = validate(sinDest);
    expect(errors.some((e) => e.property === 'destLat')).toBe(true);
  });

  it('rechaza asientos < 1 (Min 1)', () => {
    const errors = validate({ ...VALID_BASE, asientos: '0' });
    expect(errors.some((e) => e.property === 'asientos')).toBe(true);
  });

  it('rechaza limit > 50 (@Max: techo duro, el cliente no vuelca el set)', () => {
    const errors = validate({ ...VALID_BASE, limit: '51' });
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('acepta limit dentro de rango y cursor string opaco', () => {
    const errors = validate({ ...VALID_BASE, limit: '20', cursor: 'b2FxdWVlbg==' });
    expect(errors).toHaveLength(0);
  });

  it('rechaza latitud fuera de rango', () => {
    const errors = validate({ ...VALID_BASE, originLat: '200' });
    expect(errors.some((e) => e.property === 'originLat')).toBe(true);
  });
});

describe('SearchPublishedTripsDto · orden + filtros (F2b)', () => {
  it('orden es OPCIONAL (default en el service) y acepta los dos valores soportados', () => {
    expect(validate(VALID_BASE)).toHaveLength(0); // sin orden → válido (contrato intacto)
    expect(validate({ ...VALID_BASE, orden: 'salida' })).toHaveLength(0);
    expect(validate({ ...VALID_BASE, orden: 'precio' })).toHaveLength(0);
  });

  it('rechaza un orden fuera de la unión (@IsIn: sin strings sueltos)', () => {
    const errors = validate({ ...VALID_BASE, orden: 'rating' });
    expect(errors.some((e) => e.property === 'orden')).toBe(true);
  });

  it('precioMaxCents: coacciona el string de query a Int (céntimos PEN)', () => {
    const payload = { ...VALID_BASE, precioMaxCents: '4500' };
    const dto = plainToInstance(SearchPublishedTripsDto, payload);
    expect(validate(payload)).toHaveLength(0);
    expect(dto.precioMaxCents).toBe(4500);
  });

  it('precioMaxCents: rechaza < 1 (un tope de 0 no tiene sentido) y no-enteros', () => {
    expect(validate({ ...VALID_BASE, precioMaxCents: '0' }).some((e) => e.property === 'precioMaxCents')).toBe(true);
    expect(validate({ ...VALID_BASE, precioMaxCents: '45.5' }).some((e) => e.property === 'precioMaxCents')).toBe(true);
  });

  it('salidaDesde/salidaHasta: aceptan HH:mm de pared válidos (bordes 00:00 y 23:59 incluidos)', () => {
    expect(validate({ ...VALID_BASE, salidaDesde: '08:30', salidaHasta: '18:00' })).toHaveLength(0);
    expect(validate({ ...VALID_BASE, salidaDesde: '00:00', salidaHasta: '23:59' })).toHaveLength(0);
  });

  it('salidaDesde: RECHAZA hora inexistente 25:00 (regex estricta 00–23)', () => {
    const errors = validate({ ...VALID_BASE, salidaDesde: '25:00' });
    expect(errors.some((e) => e.property === 'salidaDesde')).toBe(true);
  });

  it('salidaDesde: RECHAZA 9:5 sin cero-padding (formato ambiguo)', () => {
    const errors = validate({ ...VALID_BASE, salidaDesde: '9:5' });
    expect(errors.some((e) => e.property === 'salidaDesde')).toBe(true);
  });

  it('salidaHasta: RECHAZA datetime/segundos/offset (la zona la pone el service, no el cliente)', () => {
    for (const invalida of ['2026-06-25T10:30:00-05:00', '10:30:00', '10:30Z']) {
      const errors = validate({ ...VALID_BASE, salidaHasta: invalida });
      expect(errors.some((e) => e.property === 'salidaHasta')).toBe(true);
    }
  });
});
