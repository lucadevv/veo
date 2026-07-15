import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BrowsePublishedTripsDto } from './browse-published-trips.dto';

/**
 * Validación de BORDE del BrowsePublishedTripsDto (GET /published-trips/browse · public-rail anónimo).
 * A diferencia del search, acá TODOS los params son opcionales (el feed sin filtros es válido). La región
 * se valida contra el CATÁLOGO compartido (@veo/utils REGIONS_PE): id desconocido → 400 accionable.
 */
function validate(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(BrowsePublishedTripsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

describe('BrowsePublishedTripsDto · borde', () => {
  it('TODOS los params son opcionales: el feed sin filtros ({}) es válido', () => {
    expect(validate({})).toHaveLength(0);
  });

  it('acepta una región del catálogo (id kebab-case de wire)', () => {
    expect(validate({ region: 'lima-metropolitana' })).toHaveLength(0);
    expect(validate({ region: 'arequipa' })).toHaveLength(0);
    expect(validate({ region: 'ancash' })).toHaveLength(0);
  });

  it('RECHAZA una región fuera del catálogo → 400 con mensaje que enumera los ids válidos', () => {
    const errors = validate({ region: 'narnia' });
    const regionError = errors.find((e) => e.property === 'region');
    expect(regionError).toBeDefined();
    // El mensaje es accionable: enumera el catálogo real (derivado de REGIONS_PE, no una lista paralela).
    expect(JSON.stringify(regionError?.constraints)).toContain('lima-metropolitana');
  });

  it('RECHAZA el id con casing distinto (el id de wire es exacto, case-sensitive)', () => {
    expect(validate({ region: 'Lima-Metropolitana' }).some((e) => e.property === 'region')).toBe(
      true,
    );
  });

  it('orden acepta los dos valores soportados y rechaza uno fuera de la unión', () => {
    expect(validate({ orden: 'salida' })).toHaveLength(0);
    expect(validate({ orden: 'precio' })).toHaveLength(0);
    expect(validate({ orden: 'rating' }).some((e) => e.property === 'orden')).toBe(true);
  });

  it('precioMaxCents: coacciona el string de query a Int; rechaza < 1 y no-enteros', () => {
    const payload = { precioMaxCents: '4500' };
    const dto = plainToInstance(BrowsePublishedTripsDto, payload);
    expect(validate(payload)).toHaveLength(0);
    expect(dto.precioMaxCents).toBe(4500);
    expect(validate({ precioMaxCents: '0' }).some((e) => e.property === 'precioMaxCents')).toBe(
      true,
    );
    expect(validate({ precioMaxCents: '45.5' }).some((e) => e.property === 'precioMaxCents')).toBe(
      true,
    );
  });

  it('limit acotado: rechaza > 50 (@Max) y < 1 (@Min); acepta dentro de rango con cursor opaco', () => {
    expect(validate({ limit: '51' }).some((e) => e.property === 'limit')).toBe(true);
    expect(validate({ limit: '0' }).some((e) => e.property === 'limit')).toBe(true);
    expect(validate({ limit: '20', cursor: 'b2FxdWVlbg' })).toHaveLength(0);
  });

  it('ALCANCE v1: la ventana horaria NO es parte del contrato (whitelist la PODA del DTO, sin error)', () => {
    // salidaDesde/salidaHasta no existen en el browse v1 — con whitelist se podan de la instancia validada.
    const dto = plainToInstance(BrowsePublishedTripsDto, { salidaDesde: '08:30' });
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: false });
    expect(errors).toHaveLength(0);
    expect((dto as { salidaDesde?: string }).salidaDesde).toBeUndefined();
  });
});
