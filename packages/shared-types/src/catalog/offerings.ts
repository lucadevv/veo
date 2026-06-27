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
import {
  EnergySource,
  FleetDocumentType,
  PricingMode,
  ServiceType,
  VehicleSegment,
  VEHICLE_SEGMENT_RANK,
  VehicleType,
} from '../enums/index.js';

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
  // F2.3 (ADR-017 §1.2) · tier PREMIUM: alta gama + unidad reciente. Oferta VISIBLE (defaultEnabled:true).
  VEO_PREMIUM: 'veo_premium',
  // B5-4 · verticales especiales: CODEADAS pero OCULTAS (defaultEnabled:false). El admin las
  // desbloquea por overlay (feature paga). ids = contrato INMUTABLE, igual que los de arriba.
  VEO_AMBULANCE: 'veo_ambulance',
  VEO_TOW: 'veo_tow',
  VEO_MECHANIC: 'veo_mechanic',
} as const; // ids = contrato con la app: INMUTABLES
export type OfferingId = (typeof OfferingId)[keyof typeof OfferingId];

/** Token de ícono que la app resuelve en SU registro token→glyph (mata los ternarios MOTO). */
export const OfferingIcon = {
  CAR: 'car',
  MOTO: 'moto',
  EV: 'ev',
  AMBULANCE: 'ambulance',
  TOW: 'tow',
  WRENCH: 'wrench',
} as const;
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

/** Flujo de despacho. STANDARD = matching secuencial normal. EMERGENCY = ambulancia (prioridad, no negocia). */
export const OfferingFlow = { STANDARD: 'STANDARD', EMERGENCY: 'EMERGENCY' } as const;
export type OfferingFlow = (typeof OfferingFlow)[keyof typeof OfferingFlow];

/**
 * B5-3 · REQUISITOS de eligibilidad de una oferta: el vehículo del conductor debe SATISFACERLOS para que
 * el dispatch le ofrezca ese viaje. Inclusiva hacia arriba (un vehículo "mejor" califica para una oferta
 * "menor"): confort exige segmento ≥ MID y antigüedad ≤ N; xl exige más asientos. Todos opcionales — una
 * oferta sin requisitos (económico) la cubre cualquier vehículo de su `vehicleClass`. B5-3.2: las verticales
 * especiales suman `certifications` (credenciales del CONDUCTOR, no del vehículo) — la ambulancia exige el
 * AMBULANCE_OPERATOR, etc.
 */
export interface OfferingRequirements {
  /** Asientos mínimos del vehículo (xl exige 6). */
  minSeats?: number;
  /** Segmento MÍNIMO (confort exige MID): el vehículo califica si su rank ≥ el del requisito. */
  minSegment?: VehicleSegment;
  /** Antigüedad máxima en años (confort exige ≤ 8): se evalúa contra (añoActual − vehicle.year). */
  maxAgeYears?: number;
  /**
   * B5-3.2 · CERTIFICACIONES del CONDUCTOR requeridas (no del vehículo): credenciales `FleetDocumentType` que
   * el conductor debe tener VÁLIDAS (review aprobado + sin vencer) para operar la vertical. Las requeridas
   * deben ser ⊆ las válidas del conductor. Evaluación FAIL-CLOSED (a diferencia de los attrs del vehículo):
   * sin la lista de certs del conductor → NO elegible, porque una credencial de ambulancia es un gate de
   * seguridad/legal, no un "mejor esfuerzo". Tipado (no string[]): viaja el enum, nunca un literal suelto.
   */
  certifications?: FleetDocumentType[];
}

/** Una oferta de servicio del catálogo: producto + pool + pricing + modos permitidos. */
export interface OfferingSpec {
  id: OfferingId;
  /** Token i18n (`offering.veo_moto.name`); la app resuelve. El quote SIGUE mandando `name` resuelto
   *  server-side para apps viejas (compat). */
  labelKey: string;
  icon: OfferingIcon;
  /** Pool de matching certificable: dispatch filtra por ESTO (deriva del offering, no viaja suelto). */
  vehicleClass: VehicleClass;
  /**
   * B5 · Eje 1: la VERTICAL del servicio (RIDE para las 3 ofertas vivas). Las verticales especiales
   * (AMBULANCE/TOW/MECHANIC) se shippean OCULTAS hasta desbloquearse. Default RIDE en el backfill.
   */
  serviceType: ServiceType;
  /**
   * B5 · Eje energía PARA EL QUOTE: fuente + rendimiento de REFERENCIA de la oferta. El quote cotiza
   * ANTES de asignar vehículo, así que usa esta referencia por CLASE (no el modelSpec del auto, que es
   * para la economía del conductor). `referenceEfficiency` = km por unidad de energía (km/L o km/kWh).
   */
  referenceEnergySourceId: EnergySource;
  referenceEfficiency: number;
  pricing: OfferingPricingPolicy;
  /**
   * B5-3 · requisitos de eligibilidad del vehículo (seats/segment/antigüedad). Omitido o `{}` = sin
   * requisitos extra (lo cubre cualquier vehículo de la `vehicleClass`). El dispatch filtra por esto.
   */
  requires?: OfferingRequirements;
  /** Modos que la oferta PERMITE. NUNCA vacío (spec del catálogo lo verifica). El primero es el
   *  PREFERIDO: gana cuando el schedule del admin pide un modo que la oferta no permite (§1.3). */
  allowedModes: readonly [PricingMode, ...PricingMode[]];
  flow: OfferingFlow;
  /**
   * B5-4 · visibilidad por DEFAULT cuando no hay overlay del admin para esta oferta. Las 3 ofertas RIDE
   * (+moto) nacen `true` (visibles); las verticales especiales y EV nacen `false` (CODEADAS pero ocultas
   * hasta que el admin las habilite por overlay — feature paga). `resolveCatalog` usa esto como fallback
   * de `enabled` (`ov?.enabled ?? defaultEnabled`): sin esto una oferta nueva se mostraría sola.
   */
  defaultEnabled: boolean;
  /** Orden de presentación en el quote (`OFFERING_LIST` se ordena por este campo). */
  sortOrder: number;
}

/**
 * El catálogo — la FUENTE de multiplicadores y mínimas (Lote C consumado): el preview del
 * public-bff (`maps/fare.ts`) y trip-service (FixedDispatchStrategy + re-quote de paradas) los
 * consumen de acá. Cambiar un número acá cambia el PRECIO en todos lados:
 * moto ×0.55/S\/3.00 · económico ×1.0/S\/5.00 · normal ×1.25/S\/5.00 · premium ×1.8/S\/8.00 · xl ×1.6/S\/5.00.
 */
export const OFFERINGS = {
  [OfferingId.VEO_MOTO]: {
    id: OfferingId.VEO_MOTO,
    labelKey: 'offering.veo_moto.name',
    icon: OfferingIcon.MOTO,
    vehicleClass: VehicleClass.MOTO,
    serviceType: ServiceType.RIDE,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 40, // km/L (mototaxi)
    pricing: { multiplier: 0.55, minFareCents: 300 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    // Ola 2B · mototaxi DIFERIDA: arrancamos "solo autos". La oferta queda CODEADA (matching/pricing
    // listos) pero OCULTA por defecto; el admin la habilita por overlay cuando se lance el tier moto.
    // Esta es la FUENTE ÚNICA de "MOTO no operable": de acá deriva OPERABLE_VEHICLE_CLASSES (abajo),
    // que a su vez gobierna el selector del alta y la validación server-side de fleet.
    defaultEnabled: false,
    sortOrder: 0,
  },
  [OfferingId.VEO_ECONOMICO]: {
    id: OfferingId.VEO_ECONOMICO,
    labelKey: 'offering.veo_economico.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.RIDE,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 12, // km/L (auto económico)
    pricing: { multiplier: 1.0, minFareCents: 500 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    defaultEnabled: true,
    sortOrder: 1,
  },
  [OfferingId.VEO_CONFORT]: {
    id: OfferingId.VEO_CONFORT,
    labelKey: 'offering.veo_confort.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.RIDE,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 11, // km/L (auto confort, motor mayor)
    pricing: { multiplier: 1.25, minFareCents: 500 },
    // Confort = auto de gama media o mejor, no muy viejo (BR-D04 ya exige >=2017; esto es más estricto).
    requires: { minSegment: VehicleSegment.MID, maxAgeYears: 8 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    defaultEnabled: true,
    sortOrder: 2,
  },
  [OfferingId.VEO_XL]: {
    id: OfferingId.VEO_XL,
    labelKey: 'offering.veo_xl.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.RIDE,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 8, // km/L (XL/van, mayor consumo)
    pricing: { multiplier: 1.6, minFareCents: 500 },
    // XL = capacidad: 6 asientos o más (familias/grupos). El segmento no importa, sí el tamaño.
    requires: { minSeats: 6 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    defaultEnabled: true,
    sortOrder: 4,
  },
  [OfferingId.VEO_PREMIUM]: {
    id: OfferingId.VEO_PREMIUM,
    labelKey: 'offering.veo_premium.name',
    icon: OfferingIcon.CAR, // no hay token premium; CAR es seguro. (Glyph premium dedicado = follow-up de UX.)
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.RIDE,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 9, // km/L (premium, motor mayor)
    pricing: { multiplier: 1.8, minFareCents: 800 },
    // Premium = alta gama (segmento PREMIUM) + unidad nueva (<=5 años). La FOTO del vehículo (REQUERIDA
    // para aprobar, ya capturada en onboarding) es la evidencia del operador para asignar segmento PREMIUM.
    // ADR-017 §1.2.
    requires: { minSegment: VehicleSegment.PREMIUM, maxAgeYears: 5 },
    allowedModes: [PricingMode.PUJA, PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    defaultEnabled: true,
    sortOrder: 3,
  },

  // ── B5-4 · verticales especiales: CODEADAS pero OCULTAS (defaultEnabled:false). El admin las
  // habilita por overlay cuando se venda la feature. Los pricings/eficiencias son referencias iniciales
  // que el operador afina; lo importante acá es que la LÓGICA exista y el matching las soporte. ──
  [OfferingId.VEO_AMBULANCE]: {
    id: OfferingId.VEO_AMBULANCE,
    labelKey: 'offering.veo_ambulance.name',
    icon: OfferingIcon.AMBULANCE,
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.AMBULANCE,
    referenceEnergySourceId: EnergySource.DIESEL,
    referenceEfficiency: 9, // km/L (ambulancia/van diésel)
    pricing: { multiplier: 2.5, minFareCents: 3000 },
    // La ambulancia NO negocia (invariante de dominio): solo FIXED.
    allowedModes: [PricingMode.FIXED],
    flow: OfferingFlow.EMERGENCY,
    // B5-3.2 · solo conductores con credencial de operador de ambulancia VÁLIDA (fail-closed).
    requires: { certifications: [FleetDocumentType.AMBULANCE_OPERATOR] },
    defaultEnabled: false,
    sortOrder: 10,
  },
  [OfferingId.VEO_TOW]: {
    id: OfferingId.VEO_TOW,
    labelKey: 'offering.veo_tow.name',
    icon: OfferingIcon.TOW,
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.TOW,
    referenceEnergySourceId: EnergySource.DIESEL,
    referenceEfficiency: 6, // km/L (grúa, alto consumo)
    pricing: { multiplier: 2.0, minFareCents: 4000 },
    allowedModes: [PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    // B5-3.2 · solo conductores con credencial de operador de grúa VÁLIDA (fail-closed).
    requires: { certifications: [FleetDocumentType.TOW_OPERATOR] },
    defaultEnabled: false,
    sortOrder: 11,
  },
  [OfferingId.VEO_MECHANIC]: {
    id: OfferingId.VEO_MECHANIC,
    labelKey: 'offering.veo_mechanic.name',
    icon: OfferingIcon.WRENCH,
    // Mecánico móvil: llega en moto al vehículo varado (no traslada pasajeros).
    vehicleClass: VehicleClass.MOTO,
    serviceType: ServiceType.MECHANIC,
    referenceEnergySourceId: EnergySource.GASOLINE_90,
    referenceEfficiency: 35, // km/L (moto del mecánico)
    pricing: { multiplier: 1.0, minFareCents: 2000 },
    allowedModes: [PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    // B5-3.2 · solo conductores con certificación de mecánico VÁLIDA (fail-closed).
    requires: { certifications: [FleetDocumentType.MECHANIC_CERT] },
    defaultEnabled: false,
    sortOrder: 12,
  },
} as const satisfies Record<OfferingId, OfferingSpec>;

/** Las ofertas en orden de presentación del quote (por `sortOrder`). */
export const OFFERING_LIST: readonly OfferingSpec[] = Object.values(OFFERINGS).sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

/**
 * Clases de vehículo OPERABLES = aquellas con AL MENOS una oferta habilitada por defecto
 * (`defaultEnabled`). Es la FUENTE ÚNICA de "qué se puede registrar/operar": el catálogo. Hoy, con
 * VEO_MOTO y VEO_MECHANIC en `defaultEnabled:false`, el resultado es `[CAR]` → "solo autos". Cuando se
 * habilite la mototaxi (Ola 2B, `defaultEnabled:true`), MOTO reaparece SOLA acá — y con ella el selector
 * del alta y la validación de fleet — sin tocar otro archivo. El orden sale del enum `VehicleClass`.
 */
// DEUDA: OPERABLE_VEHICLE_CLASSES deriva del default ESTÁTICO del catálogo, no del overlay runtime del admin · techo: si el admin habilita una oferta MOTO por overlay, el alta del conductor la seguiría bloqueando · gatillo: cuando el alta deba respetar overlays del admin → mover esta verdad a un endpoint overlay-aware (fleet/bff)
export const OPERABLE_VEHICLE_CLASSES: readonly VehicleClass[] = (() => {
  const enabled = new Set(OFFERING_LIST.filter((o) => o.defaultEnabled).map((o) => o.vehicleClass));
  return Object.values(VehicleClass).filter((c) => enabled.has(c));
})();

/** Clase de vehículo por DEFECTO del alta = la primera operable (hoy `CAR`). */
export const DEFAULT_VEHICLE_CLASS: VehicleClass = OPERABLE_VEHICLE_CLASSES[0] ?? VehicleClass.CAR;

/**
 * Lookup tolerante para input del cliente (string crudo): `undefined` si no existe — el caller decide.
 * SOLO resuelve keys PROPIAS del catálogo (`Object.hasOwn`): ids hostiles como `__proto__` o
 * `constructor` NO devuelven basura del prototype, devuelven `undefined`.
 */
export function findOffering(id: string): OfferingSpec | undefined {
  if (!Object.hasOwn(OFFERINGS, id)) return undefined;
  return (OFFERINGS as Record<string, OfferingSpec>)[id];
}

/**
 * Atributos del vehículo que la eligibilidad evalúa (B5-3). Salen del modelo del catálogo elegido por el
 * conductor (`VehicleModelSpec`: seats/segment) + el año del propio vehículo.
 */
export interface VehicleEligibilityAttrs {
  seats: number;
  segment: VehicleSegment;
  /** Año del vehículo (para la antigüedad; NO el rango del modelo). */
  year: number;
}

/**
 * B5-3 · ¿el vehículo SATISFACE los requisitos de la oferta? Pura y unit-testeable (sin I/O ni Date): el
 * dispatch la usa para filtrar a qué conductores ofrecer un viaje de cierta oferta. Inclusiva hacia arriba
 * (segmento por rank). Sin requisitos → siempre elegible. `currentYear` se inyecta (no se lee del reloj acá).
 */
export function isVehicleEligibleForOffering(
  requires: OfferingRequirements | undefined,
  vehicle: VehicleEligibilityAttrs,
  currentYear: number,
): boolean {
  if (!requires) return true;
  if (requires.minSeats !== undefined && vehicle.seats < requires.minSeats) return false;
  if (
    requires.minSegment !== undefined &&
    VEHICLE_SEGMENT_RANK[vehicle.segment] < VEHICLE_SEGMENT_RANK[requires.minSegment]
  ) {
    return false;
  }
  if (requires.maxAgeYears !== undefined && currentYear - vehicle.year > requires.maxAgeYears) {
    return false;
  }
  return true;
}

/**
 * B5-3.2 · ¿el CONDUCTOR tiene las certificaciones que la oferta exige? Pura, sin I/O. FAIL-CLOSED: si la
 * oferta exige certs y NO se conoce la lista de certs válidas del conductor (o no las incluye TODAS) → false.
 * Una credencial de operador (ambulancia/grúa) es un gate de seguridad/legal: a diferencia de los attrs del
 * vehículo (fail-open en el rollout), acá la AUSENCIA de dato NO habilita. Sin certs requeridas → siempre true.
 * `driverCertifications` = las certs VÁLIDAS del conductor (review aprobado + sin vencer; el caller las resuelve).
 */
export function hasRequiredCertifications(
  requires: OfferingRequirements | undefined,
  driverCertifications: readonly FleetDocumentType[] | undefined,
): boolean {
  const required = requires?.certifications;
  if (!required || required.length === 0) return true;
  const owned = new Set(driverCertifications ?? []); // sin lista → set vacío ⇒ fail-closed
  return required.every((c) => owned.has(c));
}

/**
 * B5-3.2 · eligibilidad COMPLETA de un conductor para una oferta = vehículo (attrs) ∧ conductor (certs).
 * Compositora pura de `isVehicleEligibleForOffering` (estricta por attrs) y `hasRequiredCertifications`
 * (fail-closed por certs). La usan los callers que tienen el dato completo; el pool de dispatch compone las
 * dos piezas por separado porque degrada los attrs (fail-open) y las certs (fail-closed) de forma distinta.
 */
export function isEligibleForOffering(
  requires: OfferingRequirements | undefined,
  vehicle: VehicleEligibilityAttrs,
  driverCertifications: readonly FleetDocumentType[] | undefined,
  currentYear: number,
): boolean {
  return (
    isVehicleEligibleForOffering(requires, vehicle, currentYear) &&
    hasRequiredCertifications(requires, driverCertifications)
  );
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

/**
 * Modo efectivo CON el pin por-oferta del admin (B2). Precedencia, de techo a piso:
 *  1. `offering.allowedModes` — invariante de producto (la ambulancia NO negocia): techo inviolable.
 *  2. `modePin` (admin, B2) — si está y ∈ allowedModes → GANA sobre el schedule (elección deliberada,
 *     NO un veto: `overridden` queda false).
 *  3. `scheduledMode` (schedule global, ADR 011) — el fallback cuando no hay pin (o el pin es inválido).
 * Un pin inválido (∉ allowedModes) ya viene descartado por `resolveCatalog` (`modePin: undefined`); aun
 * así esta función lo re-chequea (defensa en profundidad) y cae a la intersección schedule ∩ oferta.
 */
export function resolveOfferingModeWithPin(
  offering: OfferingSpec,
  modePin: PricingMode | undefined,
  scheduledMode: PricingMode,
): ResolvedOfferingMode {
  if (modePin !== undefined && offering.allowedModes.includes(modePin)) {
    return { mode: modePin, overridden: false };
  }
  return resolveOfferingMode(offering, scheduledMode);
}

// ── Catálogo editable en caliente (ADR 013 §1.2, puerta de escape · Fase B/B1) ─────────────────────
// El código `OFFERINGS` es la BASE inmutable de producto (ids, clase de vehículo, pricing/allowedModes
// por defecto). La DB guarda solo el OVERLAY que el admin edita en caliente — replicando el patrón
// `PricingModeSchedule` (singleton + version + outbox). B1: el overlay lleva `enabled` por oferta;
// B2 sumará overrides de modo/precio. El catálogo EFECTIVO = base ⟕ overlay.

/**
 * Override editable por el admin de UNA oferta (caliente). B1: `enabled`. B2 suma modo + precio:
 *  - `mode`: PIN del modo de pricing para ESTA oferta. Si está y ∈ `allowedModes` → gana sobre el
 *    schedule global (ADR 011). Si ∉ `allowedModes` → se IGNORA (la oferta veta, igual que al schedule).
 *    `undefined` → sin pin, manda el schedule.
 *  - `multiplier` / `minFareCents`: override de `OfferingPricingPolicy`. `undefined` → el valor de código.
 *    La tarifa SIGUE saliendo de la fórmula (distancia/tiempo); estos solo escalan/pisan (ADR 013 §1.7).
 */
export interface OfferingOverride {
  id: OfferingId;
  enabled: boolean;
  mode?: PricingMode;
  multiplier?: number;
  minFareCents?: number;
}

/**
 * El overlay COMPLETO que el admin edita (wholesale, como el schedule de pricing). Versionado en DB.
 * NO duplica la base de código: solo lo CONFIGURABLE en caliente.
 */
export interface OfferingCatalogOverlay {
  overrides: readonly OfferingOverride[];
  version: number;
}

/**
 * Una oferta del catálogo EFECTIVO: la spec base + su estado configurable resuelto. `pricing` ya es el
 * EFECTIVO (base ⟕ override del admin). `modePin` es el modo pineado por el admin YA validado contra
 * `allowedModes` (un pin inválido se descarta acá → `undefined`); el consumidor no re-valida.
 */
export interface ResolvedOffering extends OfferingSpec {
  enabled: boolean;
  modePin?: PricingMode;
}

/**
 * Catálogo EFECTIVO = `OFFERINGS` (base de código) ⟕ overlay (config DB del admin), en `sortOrder`.
 * Caminos infelices (ADR 013 §2):
 *  - oferta SIN entrada en el overlay → `enabled: true`, pricing de código, sin pin (no esconder lo shippeado).
 *  - overlay con un id que ya no existe en código → se IGNORA (el código es la fuente de ids válidos).
 *  - overlay `null` (DB vacía/caída) → todas habilitadas, pricing de código (degradación honesta).
 *  - B2: `multiplier`/`minFareCents` del override pisan el pricing de código (campo a campo); un `mode`
 *    pineado FUERA de `allowedModes` se descarta (la oferta veta) → `modePin` queda `undefined`.
 */
export function resolveCatalog(
  overlay: OfferingCatalogOverlay | null,
): readonly ResolvedOffering[] {
  const overrideById = new Map((overlay?.overrides ?? []).map((o) => [o.id, o]));
  return OFFERING_LIST.map((spec) => {
    const ov = overrideById.get(spec.id);
    const pricing: OfferingPricingPolicy = {
      multiplier: ov?.multiplier ?? spec.pricing.multiplier,
      minFareCents: ov?.minFareCents ?? spec.pricing.minFareCents,
    };
    const modePin =
      ov?.mode !== undefined && spec.allowedModes.includes(ov.mode) ? ov.mode : undefined;
    return { ...spec, pricing, enabled: ov?.enabled ?? spec.defaultEnabled, modePin };
  });
}

/** Solo las ofertas ACTIVAS (las que el quote cotiza y la teaser del Home muestra). */
export function activeOfferings(
  overlay: OfferingCatalogOverlay | null,
): readonly ResolvedOffering[] {
  return resolveCatalog(overlay).filter((offering) => offering.enabled);
}
