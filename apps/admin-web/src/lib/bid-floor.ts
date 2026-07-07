import { GLOBAL_ZONE } from '@veo/shared-types';
import type { BidFloorOverride, BidFloorView, ReplaceBidFloorRequest } from '@/lib/api/schemas';

/**
 * Helpers PUROS del piso de la PUJA para la pantalla "Ofertas de servicio" (A1). El piso vive en su PROPIO
 * config (`PUT /pricing/bid-floor`, su propia versión/CAS), distinto del catálogo — por eso estos helpers
 * NO conocen al catálogo: solo resuelven/arman el overlay del bid-floor y comparan los dos mínimos.
 *
 * Espejo de cordura del `BID_FLOOR_MAX_CENTS` server-side (defensa en profundidad UI, igual que el panel de
 * Precios). S/1000. La fuente autoritativa sigue siendo el DTO del trip-service; este literal solo corta el
 * dedazo ANTES de mandar.
 */
export const BID_FLOOR_MAX_SOLES = 1000;

/**
 * El override EXPLÍCITO del piso de ESTA oferta en la zona global, o `null` si no tiene (cae al default).
 * Es el valor que puebla el `<input>` de la fila (vacío = sin override), espejo de cómo el panel de Precios
 * lee `config.overrides` por (GLOBAL_ZONE, offeringId).
 */
export function offeringFloorOverrideCents(
  bidFloor: Pick<BidFloorView, 'overrides'>,
  offeringId: string,
): number | null {
  const ov = bidFloor.overrides.find((o) => o.zone === GLOBAL_ZONE && o.offeringId === offeringId);
  return ov ? ov.floorCents : null;
}

/**
 * El piso EFECTIVO de una oferta = su override si existe, si no el default. Siempre resoluble (el default
 * siempre está). Es el "mínimo que se puede pujar" que entra en la validación cruzada contra la tarifa fija.
 */
export function effectiveFloorCents(bidFloor: BidFloorView, offeringId: string): number {
  return offeringFloorOverrideCents(bidFloor, offeringId) ?? bidFloor.defaultFloorCents;
}

/**
 * FULL-REPLACE de los overrides del bid-floor cambiando SOLO el de una oferta (zona global): upsert con
 * `cents`, o quita el override con `null` (vacío = sin override → usa el default). Preserva TODO lo demás,
 * incluidos overrides de otras zonas (zone-ready) y de otras ofertas — el `PUT /pricing/bid-floor` es
 * wholesale, así que hay que remandar el set entero. Hermano de `withOverride` del catálogo.
 */
export function withFloorOverride(
  base: readonly BidFloorOverride[],
  offeringId: string,
  cents: number | null,
): BidFloorOverride[] {
  const rest = base.filter((o) => !(o.zone === GLOBAL_ZONE && o.offeringId === offeringId));
  if (cents === null) return rest;
  return [...rest, { zone: GLOBAL_ZONE, offeringId, floorCents: cents }];
}

/**
 * Body del `PUT /pricing/bid-floor` cuando SOLO cambia el piso por DEFECTO global (panel de Precios, A2). El PUT
 * es wholesale, así que hay que REMANDAR los overrides por oferta TAL CUAL están persistidos: esos pisos por
 * oferta se editan en "Ofertas de servicio" (A1) y perderlos sería borrar dinero. `expectedVersion` = el CAS del
 * config cargado (si otro admin lo movió → 409). Espejo de la semántica preservadora de `withFloorOverride`.
 */
export function bidFloorDefaultReplace(
  config: Pick<BidFloorView, 'overrides' | 'version'>,
  defaultFloorCents: number,
): ReplaceBidFloorRequest {
  return {
    defaultFloorCents,
    overrides: config.overrides,
    expectedVersion: config.version,
  };
}

/**
 * El caso confuso que A1 existe para exponer: el piso de la PUJA supera la tarifa mínima FIJA, así que el
 * MISMO viaje sale más barato en FIJO que el mínimo que se puede pujar. Ambos en céntimos; `null`/no-finito
 * = no comparable (no se advierte). Puro y simétrico para testear el límite sin tocar el DOM.
 */
export function pujaFloorExceedsFixedMin(
  floorCents: number | null,
  fixedMinCents: number | null,
): boolean {
  if (floorCents === null || fixedMinCents === null) return false;
  if (!Number.isFinite(floorCents) || !Number.isFinite(fixedMinCents)) return false;
  return floorCents > fixedMinCents;
}
