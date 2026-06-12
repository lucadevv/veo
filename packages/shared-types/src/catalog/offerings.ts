/**
 * Catálogo de ServiceOfferings (ADR 013) — fuente ÚNICA de los tres ejes de servicio:
 * clase de vehículo (pool de matching), política de pricing POR oferta y modos de pricing permitidos.
 *
 * Los multiplicadores/mínimas viven ACÁ y solo acá (Lote C consumado): el quote del public-bff
 * (`maps/fare.ts`) y trip-service (tarifa firme FIXED + re-quote de paradas) los IMPORTAN de este
 * catálogo — no existe espejo de constantes que pueda divergir. `as const satisfies
 * Record<OfferingId, OfferingSpec>` da exhaustividad en compile-time: un `OfferingId` nuevo sin
 * entrada en `OFFERINGS` no compila.
 */
import { PricingMode, VehicleType } from '../enums/index.js';

/** Alias semántico: la KEY del pool de matching. El wire field sigue siendo `vehicleType` (contrato). */
export const VehicleClass = VehicleType; // mismo objeto: CAR | MOTO (cerrado)
export type VehicleClass = VehicleType;

/**
 * Ids de producto de las ofertas. NO cambian: son CONTRATO con la app (viajan en el quote y en
 * `createTrip.category`, y están persistidos en `Trip.category`). Una oferta nueva = un id nuevo;
 * los existentes son inmutables.
 */
export const OfferingId = {
  VEO_MOTO: 'veo_moto',
  VEO_ECONOMICO: 'veo_economico',
  VEO_CONFORT: 'veo_confort',
  VEO_XL: 'veo_xl',
} as const; // ids = contrato con la app: INMUTABLES
export type OfferingId = (typeof OfferingId)[keyof typeof OfferingId];

/** Token de ícono que la app resuelve en SU registro token→glyph (mata los ternarios MOTO). */
export const OfferingIcon = { CAR: 'car', MOTO: 'moto' } as const; // futuro: 'ambulance', 'wrench'…
export type OfferingIcon = (typeof OfferingIcon)[keyof typeof OfferingIcon];

/**
 * Recargo del Modo Niño (BR-T07): S/ 2.00 en céntimos PEN. FUENTE ÚNICA — aplica SOLO en viajes de
 * precio FIJO (en PUJA el bid ES el precio, no se recarga). trip-service lo suma en `calculateFare`
 * (FIXED) y la app lo muestra en el desglose ANTES de confirmar; ambos consumen ESTA constante para
 * que el número no diverja entre server y cliente. `as const` la fija como literal `200`.
 */
export const CHILD_MODE_FEE_CENTS = 200 as const;

/** Política de pricing de una oferta. FUENTE ÚNICA (ADR 013): BFF y trip-service la consumen de acá. */
export interface OfferingPricingPolicy {
  /** Multiplicador sobre la fórmula base BR-T05 (económico = 1.0). */
  multiplier: number;
  /** Tarifa mínima cobrable, céntimos PEN (moto 300, autos 500). */
  minFareCents: number;
}

/** Flujo de despacho. MVP: STANDARD único. EMERGENCY (ambulancia) = valor + strategy futuros. */
export const OfferingFlow = { STANDARD: 'STANDARD' } as const;
export type OfferingFlow = (typeof OfferingFlow)[keyof typeof OfferingFlow];

/** Una oferta de servicio del catálogo: producto + pool + pricing + modos permitidos. */
export interface OfferingSpec {
  id: OfferingId;
  /** Token i18n (`offering.veo_moto.name`); la app resuelve. El quote SIGUE mandando `name` resuelto
   *  server-side para apps viejas (compat). */
  labelKey: string;
  icon: OfferingIcon;
  /** Pool de matching certificable: dispatch filtra por ESTO (deriva del offering, no viaja suelto). */
  vehicleClass: VehicleClass;
  pricing: OfferingPricingPolicy;
  /** Modos que la oferta PERMITE. NUNCA vacío (spec del catálogo lo verifica). El primero es el
   *  PREFERIDO: gana cuando el schedule del admin pide un modo que la oferta no permite (§1.3). */
  allowedModes: readonly [PricingMode, ...PricingMode[]];
  flow: OfferingFlow;
  /** Orden de presentación en el quote (`OFFERING_LIST` se ordena por este campo). */
  sortOrder: number;
}

/**
 * El catálogo — la FUENTE de multiplicadores y mínimas (Lote C consumado): el preview del
 * public-bff (`maps/fare.ts`) y trip-service (FixedDispatchStrategy + re-quote de paradas) los
 * consumen de acá. Cambiar un número acá cambia el PRECIO en todos lados:
 * moto ×0.55/S\/3.00 · económico ×1.0/S\/5.00 · confort ×1.25/S\/5.00 · xl ×1.6/S\/5.00.
 */
export const OFFERINGS = {
  [OfferingId.VEO_MOTO]: {
    id: OfferingId.VEO_MOTO,
    labelKey: 'offering.veo_moto.name',
    icon: OfferingIcon.MOTO,
    vehicleClass: VehicleClass.MOTO,
    pricing: { multiplier: 0.55, minFareCents: 300 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 0,
  },
  [OfferingId.VEO_ECONOMICO]: {
    id: OfferingId.VEO_ECONOMICO,
    labelKey: 'offering.veo_economico.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.0, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 1,
  },
  [OfferingId.VEO_CONFORT]: {
    id: OfferingId.VEO_CONFORT,
    labelKey: 'offering.veo_confort.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.25, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 2,
  },
  [OfferingId.VEO_XL]: {
    id: OfferingId.VEO_XL,
    labelKey: 'offering.veo_xl.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.6, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 3,
  },
} as const satisfies Record<OfferingId, OfferingSpec>;

/** Las ofertas en orden de presentación del quote (por `sortOrder`). */
export const OFFERING_LIST: readonly OfferingSpec[] = Object.values(OFFERINGS).sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

/**
 * Lookup tolerante para input del cliente (string crudo): `undefined` si no existe — el caller decide.
 * SOLO resuelve keys PROPIAS del catálogo (`Object.hasOwn`): ids hostiles como `__proto__` o
 * `constructor` NO devuelven basura del prototype, devuelven `undefined`.
 */
export function findOffering(id: string): OfferingSpec | undefined {
  if (!Object.hasOwn(OFFERINGS, id)) return undefined;
  return (OFFERINGS as Record<string, OfferingSpec>)[id];
}

/** Resultado de `resolveOfferingMode`: el modo efectivo + si la oferta vetó al schedule. */
export interface ResolvedOfferingMode {
  mode: PricingMode;
  /** true si el schedule pidió un modo que la oferta NO permite (observabilidad: warn + counter). */
  overridden: boolean;
}

/**
 * Intersección oferta ∩ schedule (ADR 013 §1.3) — pura, unit-testeable; trip-service la consume.
 * El schedule del admin PROPONE (`scheduledMode`); la oferta ACOTA: si el modo propuesto está en
 * `allowedModes` gana el schedule; si no, gana la oferta con su modo PREFERIDO (`allowedModes[0]`)
 * y `overridden: true` para que el caller loguee warn + bumpee el counter
 * (`pricing_offering_mode_overridden`). "La ambulancia NO negocia" es invariante de dominio,
 * no esperanza de configuración.
 */
export function resolveOfferingMode(
  offering: OfferingSpec,
  scheduledMode: PricingMode,
): ResolvedOfferingMode {
  if (offering.allowedModes.includes(scheduledMode)) {
    return { mode: scheduledMode, overridden: false };
  }
  return { mode: offering.allowedModes[0], overridden: true };
}
