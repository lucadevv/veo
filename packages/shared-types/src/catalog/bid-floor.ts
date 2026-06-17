/**
 * Piso de la PUJA (bid floor) editable en caliente, keyed por (zona, oferta) — ADR 010 §9.3.
 *
 * FUENTE ÚNICA de la resolución del piso: trip-service (autoritativo, en createTrip/rebid) y el public-bff
 * (display del quote) IMPORTAN `resolveBidFloorCents` de acá — NO hay espejo de lógica que pueda divergir
 * (mismo principio que `OFFERINGS`/`resolveCatalog`). Reemplaza el escalar global hardcodeado en env
 * (`BID_FLOOR_CENTS`) por config versionada en DB que el admin maneja, replicando el patrón
 * `PricingModeSchedule`/`FuelSurchargeConfig` (singleton + version + outbox + cache).
 *
 * Per-OFERTA funciona hoy (las ofertas existen: moto < confort). Per-ZONA queda zone-ready: la firma ya
 * transporta la `zone`, así que el día que `toZone()` resuelva zonas reales el piso por zona funciona sin
 * tocar este resolver ni los consumidores (Tier 2, no-breaking).
 */
import { type OfferingId } from './offerings.js';

/**
 * Clave de zona de pricing. MVP: SIEMPRE 'GLOBAL' (Tier 1) — espeja `ZoneKey` de trip-service. Tier 2
 * (per-zona real, con polígonos/celdas H3) = no-breaking: solo cambia qué devuelve `toZone()`.
 */
export type PricingZoneKey = 'GLOBAL';

/** Zona global única del MVP (Tier 1). */
export const GLOBAL_ZONE: PricingZoneKey = 'GLOBAL';

/**
 * Piso del bid por DEFECTO en céntimos PEN (S/7). Valor histórico del sistema: con config ausente o sin
 * override para la oferta, este es el piso — comportamiento idéntico al `BID_FLOOR_CENTS=700` previo.
 */
export const DEFAULT_BID_FLOOR_CENTS = 700;

/**
 * Techo de cordura del piso (céntimos PEN): S/1000. Guardarraíl anti-dedazo del admin (un piso de
 * S/100000 dejaría a TODA una oferta sin poder pujar). El DTO del PUT lo valida; acá queda documentado.
 */
export const BID_FLOOR_MAX_CENTS = 100_000;

/**
 * Override del piso para una (zona, oferta) concreta. `floorCents` es el piso EFECTIVO de esa combinación
 * (no un delta sobre el default). Una combinación sin override cae al `defaultFloorCents`.
 */
export interface BidFloorOverride {
  zone: PricingZoneKey;
  offeringId: OfferingId;
  floorCents: number;
}

/**
 * Config COMPLETA del piso de puja, editable en caliente (reemplazo wholesale, como el schedule). El admin
 * fija un piso por defecto + overrides por (zona, oferta). Versionada en DB (CAS optimista).
 */
export interface BidFloorConfig {
  defaultFloorCents: number;
  overrides: readonly BidFloorOverride[];
}

/** Config por defecto (degradación honesta): piso global S/7, sin overrides. = comportamiento previo. */
export const DEFAULT_BID_FLOOR_CONFIG: BidFloorConfig = {
  defaultFloorCents: DEFAULT_BID_FLOOR_CENTS,
  overrides: [],
};

/**
 * Resuelve el piso de puja para (zona, oferta) — PURA, sin I/O, unit-testeable. Precedencia, de específico
 * a general:
 *  1. Override EXACTO (misma zona ∧ misma oferta) → su `floorCents`.
 *  2. `defaultFloorCents` (sin override para esa combinación).
 *
 * La consumen trip-service (gate autoritativo de la puja en createTrip/rebid) y el public-bff (piso de
 * DISPLAY por oferta en el quote) → un solo lugar de decisión, consistente quote↔create por construcción.
 */
export function resolveBidFloorCents(
  config: BidFloorConfig,
  zone: PricingZoneKey,
  offeringId: OfferingId,
): number {
  const override = config.overrides.find((o) => o.zone === zone && o.offeringId === offeringId);
  return override?.floorCents ?? config.defaultFloorCents;
}
