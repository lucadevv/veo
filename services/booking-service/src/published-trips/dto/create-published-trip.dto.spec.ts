// `@Type(() => StopoverDto)` (class-transformer) usa Reflect.getMetadata al materializar el DTO anidado;
// los specs no cargan reflect-metadata global (vitest.config), así que lo importamos acá (igual que main.ts).
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ModoReserva } from '../../generated/prisma';
import { CreatePublishedTripDto } from './create-published-trip.dto';

/**
 * Validación de BORDE del CreatePublishedTripDto (FIX 1 anti-lucro): el `orden` de un stopover es ≥ 1 (el 0
 * está RESERVADO al origen) y los stopovers de la ruta tienen órdenes ÚNICOS (`@ArrayUnique` por `orden`). Sin
 * estos guards, un orden colisionante (0, duplicado, o = destino) pisaría hitos al armar el Map → distancia
 * de tramo inflada → tope inflado → lucro. El dominio re-valida {1..n} contiguo (defensa en profundidad).
 */
const VALID_BASE = {
  vehicleId: '11111111-1111-4111-8111-111111111111',
  origenLat: -12.0464,
  origenLon: -77.0428,
  destinoLat: -13.52,
  destinoLon: -71.97,
  fechaHoraSalida: new Date(Date.now() + 86_400_000).toISOString(),
  asientosTotales: 3,
  precioBase: 4500,
  modoReserva: ModoReserva.REVISION_CADA_SOLICITUD,
};

function validate(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(CreatePublishedTripDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

describe('CreatePublishedTripDto · stopovers orden (FIX 1: borde anti-lucro)', () => {
  it('acepta stopovers con órdenes {1..n} únicos', () => {
    const errors = validate({
      ...VALID_BASE,
      stopovers: [
        { lat: -12.1, lon: -77.0, orden: 1 },
        { lat: -12.2, lon: -77.0, orden: 2 },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it('acepta el payload sin stopovers (es opcional)', () => {
    expect(validate({ ...VALID_BASE })).toHaveLength(0);
  });

  it('rechaza un stopover con orden=0 (reservado al origen → @Min(1))', () => {
    const errors = validate({
      ...VALID_BASE,
      stopovers: [{ lat: -12.1, lon: -77.0, orden: 0 }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rechaza un stopover con orden negativo', () => {
    const errors = validate({
      ...VALID_BASE,
      stopovers: [{ lat: -12.1, lon: -77.0, orden: -1 }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rechaza dos stopovers con el MISMO orden (@ArrayUnique por orden)', () => {
    const errors = validate({
      ...VALID_BASE,
      stopovers: [
        { lat: -12.1, lon: -77.0, orden: 1 },
        { lat: -12.2, lon: -77.0, orden: 1 },
      ],
    });
    const stopoversError = errors.find((e) => e.property === 'stopovers');
    expect(stopoversError?.constraints).toHaveProperty('arrayUnique');
  });
});

describe('CreatePublishedTripDto · tollsCents (peaje declarado, F2.5)', () => {
  it('acepta un peaje entero ≥ 0', () => {
    expect(validate({ ...VALID_BASE, tollsCents: 800 })).toHaveLength(0);
    expect(validate({ ...VALID_BASE, tollsCents: 0 })).toHaveLength(0);
  });

  it('acepta el payload SIN peaje (opcional, default 0 en el service)', () => {
    expect(validate({ ...VALID_BASE })).toHaveLength(0);
  });

  it('rechaza un peaje negativo (@Min(0) — el dinero no es negativo)', () => {
    expect(validate({ ...VALID_BASE, tollsCents: -1 }).length).toBeGreaterThan(0);
  });

  it('rechaza un peaje no entero (céntimos Int, jamás float)', () => {
    expect(validate({ ...VALID_BASE, tollsCents: 12.5 }).length).toBeGreaterThan(0);
  });

  it('TOPA el peaje en MAX_TOLLS_CENTS (techo de cordura anti-inflado): 50_001 → rechaza', () => {
    expect(validate({ ...VALID_BASE, tollsCents: 50_001 }).length).toBeGreaterThan(0);
    expect(validate({ ...VALID_BASE, tollsCents: 50_000 })).toHaveLength(0);
  });
});
