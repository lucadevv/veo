import { describe, it, expect } from 'vitest';
import { GLOBAL_ZONE, OfferingId } from '@veo/shared-types';
import type { BidFloorOverride, BidFloorView } from '@/lib/api/schemas';
import {
  effectiveFloorCents,
  offeringFloorOverrideCents,
  pujaFloorExceedsFixedMin,
  withFloorOverride,
} from './bid-floor';

const ov = (offeringId: string, floorCents: number, zone: string = GLOBAL_ZONE): BidFloorOverride => ({
  zone,
  offeringId,
  floorCents,
});

const view = (overrides: BidFloorOverride[], defaultFloorCents = 700): BidFloorView => ({
  defaultFloorCents,
  overrides,
  version: 1,
  updatedAt: '2026-06-30T00:00:00.000Z',
});

/**
 * Resolución del piso por oferta: el override explícito (zona global) o `null` (cae al default). Es lo que
 * puebla el `<input>` de la fila — vacío = sin override.
 */
describe('offeringFloorOverrideCents · override explícito o null', () => {
  it('devuelve el override de la oferta cuando existe en la zona global', () => {
    expect(offeringFloorOverrideCents(view([ov(OfferingId.VEO_MOTO, 300)]), OfferingId.VEO_MOTO)).toBe(300);
  });

  it('devuelve null cuando la oferta no tiene override (usa el default)', () => {
    expect(offeringFloorOverrideCents(view([]), OfferingId.VEO_MOTO)).toBeNull();
  });

  it('ignora overrides de OTRAS zonas (hoy solo GLOBAL; zone-ready)', () => {
    expect(
      offeringFloorOverrideCents(view([ov(OfferingId.VEO_MOTO, 300, 'LIMA_NORTE')]), OfferingId.VEO_MOTO),
    ).toBeNull();
  });
});

/** El piso efectivo = override ?? default. Siempre resoluble; es el operando de la validación cruzada. */
describe('effectiveFloorCents · override o default', () => {
  it('usa el override cuando existe', () => {
    expect(effectiveFloorCents(view([ov(OfferingId.VEO_MOTO, 300)], 700), OfferingId.VEO_MOTO)).toBe(300);
  });

  it('cae al default cuando no hay override', () => {
    expect(effectiveFloorCents(view([], 700), OfferingId.VEO_MOTO)).toBe(700);
  });
});

/**
 * Full-replace del overlay del bid-floor: el `PUT` es wholesale, así que cambiar UNA oferta debe remandar el
 * set entero con esa oferta actualizada/quitada y TODO lo demás intacto. Hermano de `withOverride` del catálogo.
 */
describe('withFloorOverride · upsert/quita preservando el resto', () => {
  it('UPSERT: agrega el override de una oferta que no lo tenía', () => {
    const out = withFloorOverride([], OfferingId.VEO_MOTO, 300);
    expect(out).toEqual([ov(OfferingId.VEO_MOTO, 300)]);
  });

  it('UPSERT: reemplaza el override previo de la MISMA oferta (no duplica)', () => {
    const out = withFloorOverride([ov(OfferingId.VEO_MOTO, 300)], OfferingId.VEO_MOTO, 450);
    expect(out).toEqual([ov(OfferingId.VEO_MOTO, 450)]);
  });

  it('QUITA: null borra el override → la oferta vuelve al default', () => {
    const out = withFloorOverride([ov(OfferingId.VEO_MOTO, 300)], OfferingId.VEO_MOTO, null);
    expect(out).toEqual([]);
  });

  it('preserva los overrides de OTRAS ofertas (replace wholesale)', () => {
    const base = [ov(OfferingId.VEO_CONFORT, 900)];
    const out = withFloorOverride(base, OfferingId.VEO_MOTO, 300);
    expect(out).toContainEqual(ov(OfferingId.VEO_CONFORT, 900));
    expect(out).toContainEqual(ov(OfferingId.VEO_MOTO, 300));
  });

  it('preserva overrides de OTRAS zonas al tocar la global (zone-ready, no los pisa)', () => {
    const base = [ov(OfferingId.VEO_MOTO, 500, 'LIMA_NORTE')];
    const out = withFloorOverride(base, OfferingId.VEO_MOTO, 300);
    expect(out).toContainEqual(ov(OfferingId.VEO_MOTO, 500, 'LIMA_NORTE'));
    expect(out).toContainEqual(ov(OfferingId.VEO_MOTO, 300));
  });
});

/**
 * La validación cruzada (la pieza clave de A1): el piso de la PUJA supera la tarifa mínima FIJA → el mismo
 * viaje sale más barato en FIJO que el mínimo pujable. Cubre el límite (igual = NO advierte) y los no-comparables.
 */
describe('pujaFloorExceedsFixedMin · el caso confuso', () => {
  it('advierte cuando el piso de puja > tarifa mínima fija (S/7 > S/3)', () => {
    expect(pujaFloorExceedsFixedMin(700, 300)).toBe(true);
  });

  it('NO advierte cuando el piso es igual a la tarifa fija (límite, no es incongruencia)', () => {
    expect(pujaFloorExceedsFixedMin(300, 300)).toBe(false);
  });

  it('NO advierte cuando el piso es menor que la tarifa fija (caso sano)', () => {
    expect(pujaFloorExceedsFixedMin(300, 700)).toBe(false);
  });

  it('NO advierte si alguno no es comparable (null o no-finito)', () => {
    expect(pujaFloorExceedsFixedMin(null, 300)).toBe(false);
    expect(pujaFloorExceedsFixedMin(700, null)).toBe(false);
    expect(pujaFloorExceedsFixedMin(Number.NaN, 300)).toBe(false);
  });
});
