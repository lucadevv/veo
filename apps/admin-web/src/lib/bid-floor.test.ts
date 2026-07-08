import { describe, it, expect } from 'vitest';
import { OfferingId } from '@veo/shared-types';
import type { BidFloorOverride, BidFloorView } from '@/lib/api/schemas';
import {
  bidFloorDefaultReplace,
  effectiveFloorCents,
  offeringFloorOverrideCents,
  pujaFloorExceedsFixedMin,
  withFloorOverride,
} from './bid-floor';

const ov = (offeringId: string, floorCents: number): BidFloorOverride => ({
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
 * Resolución del piso por oferta: el override explícito o `null` (cae al default). Es lo que
 * puebla el `<input>` de la fila — vacío = sin override.
 */
describe('offeringFloorOverrideCents · override explícito o null', () => {
  it('devuelve el override de la oferta cuando existe', () => {
    expect(
      offeringFloorOverrideCents(view([ov(OfferingId.VEO_MOTO, 300)]), OfferingId.VEO_MOTO),
    ).toBe(300);
  });

  it('devuelve null cuando la oferta no tiene override (usa el default)', () => {
    expect(offeringFloorOverrideCents(view([]), OfferingId.VEO_MOTO)).toBeNull();
  });

  it('devuelve null para una oferta distinta a la que tiene override', () => {
    expect(
      offeringFloorOverrideCents(view([ov(OfferingId.VEO_CONFORT, 900)]), OfferingId.VEO_MOTO),
    ).toBeNull();
  });
});

/** El piso efectivo = override ?? default. Siempre resoluble; es el operando de la validación cruzada. */
describe('effectiveFloorCents · override o default', () => {
  it('usa el override cuando existe', () => {
    expect(
      effectiveFloorCents(view([ov(OfferingId.VEO_MOTO, 300)], 700), OfferingId.VEO_MOTO),
    ).toBe(300);
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
});

/**
 * A2 — el panel de Precios edita SOLO el piso por defecto global. Como el `PUT` es wholesale, el body debe
 * REMANDAR los overrides por oferta TAL CUAL están persistidos (se editan en "Ofertas de servicio"): perderlos
 * sería borrar dinero. Este es el invariante que blinda el adelgazamiento del panel.
 */
describe('bidFloorDefaultReplace · cambia el default PRESERVANDO los overrides por oferta', () => {
  it('arma el body con el nuevo default y los overrides INTACTOS', () => {
    const config = view([ov(OfferingId.VEO_MOTO, 300), ov(OfferingId.VEO_CONFORT, 900)], 700);
    const body = bidFloorDefaultReplace(config, 800);
    expect(body).toEqual({
      defaultFloorCents: 800,
      overrides: [ov(OfferingId.VEO_MOTO, 300), ov(OfferingId.VEO_CONFORT, 900)],
      expectedVersion: 1,
    });
  });

  it('NO borra ningún override aunque el panel ya no los muestre (regresión de A2)', () => {
    const overrides = [ov(OfferingId.VEO_MOTO, 300), ov(OfferingId.VEO_XL, 1200)];
    const body = bidFloorDefaultReplace(view(overrides, 700), 500);
    expect(body.overrides).toEqual(overrides);
  });

  it('remite expectedVersion = la versión cargada (CAS), no la reinventa', () => {
    expect(bidFloorDefaultReplace({ overrides: [], version: 42 }, 600).expectedVersion).toBe(42);
  });

  it('preserva un set vacío de overrides sin inventar ninguno', () => {
    expect(bidFloorDefaultReplace(view([], 700), 800).overrides).toEqual([]);
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
