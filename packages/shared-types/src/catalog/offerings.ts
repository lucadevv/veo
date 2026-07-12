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
 * precio FIJO (en PUJA el bid ES el precio, no se recarga). trip-service lo suma PLANO en `calculateFirmFare`
 * (DESPUÉS del multiplier de la oferta, así el tier NO lo escala) y la app lo muestra en el desglose ANTES
 * de confirmar; ambos consumen ESTA constante y el número cobrado coincide EXACTO en cualquier tier.
 * `as const` la fija como literal `200`.
 */
export const CHILD_MODE_FEE_CENTS = 200 as const;

/**
 * Límites del multiplicador de surge (BR-T06 · ADR-021 Fase C): [1.0, 2.0]. FUENTE ÚNICA — el surge es
 * server-authoritative: dispatch lo calcula, trip-service lo aplica al COBRO firme y el QUOTE del BFF lo
 * aplica al PREVIEW; los tres consumen ESTOS límites para que el rango no diverja. 1.0 = sin recargo (default),
 * 2.0 = tope. `as const` los fija como literales.
 */
export const MIN_SURGE = 1.0 as const;
export const MAX_SURGE = 2.0 as const;

/**
 * Política de pricing de una oferta. FUENTE ÚNICA (ADR 013 · ADR 023): BFF y trip-service la consumen de acá.
 * `multiplier` y `minFareCents` son OBLIGATORIOS. Los params `baseFareCents`/`perKmCents`/`perMinCents` son
 * OVERRIDES OPCIONALES por servicio (ADR 023 §3): `undefined` → usa el DEFAULT global (`BaseFareConfig`). Un
 * servicio los pone para diferenciarse de la fórmula base — p.ej. el Mecánico (call-out plano) pone
 * `perKmCents:0` Y `perMinCents:0` (una visita no cobra por distancia ni por tiempo, la labor se cobra aparte);
 * la Grúa pone `perMinCents:0` (hook-up + por-km, sin tiempo).
 */
export interface OfferingPricingPolicy {
  /** Multiplicador sobre la fórmula base BR-T05 (económico = 1.0). */
  multiplier: number;
  /** Tarifa mínima cobrable, céntimos PEN (moto 300, autos 500). */
  minFareCents: number;
  /** Override del banderazo (céntimos PEN). `undefined` → default global. */
  baseFareCents?: number;
  /** Override del por-km (céntimos PEN). `0` = no cobra distancia (Mecánico). `undefined` → default global. */
  perKmCents?: number;
  /** Override del por-minuto (céntimos PEN). `0` = no cobra tiempo (Grúa/Mecánico). `undefined` → default global. */
  perMinCents?: number;
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
  pricing: OfferingPricingPolicy;
  /**
   * B5-3 · requisitos de eligibilidad del vehículo (seats/segment/antigüedad). Omitido o `{}` = sin
   * requisitos extra (lo cubre cualquier vehículo de la `vehicleClass`). El dispatch filtra por esto.
   */
  requires?: OfferingRequirements;
  /**
   * ADR 023 · El modo de pricing de la oferta (FIXED = Uber · PUJA = inDrive). Es el DEFAULT de código;
   * si `modeLocked` es false, el admin lo cambia A MANO por overlay (palanca manual, ADR 023 §1.1). NO hay
   * schedule/franjas (ADR 011 superseded): el sistema nunca lo flipea solo.
   */
  mode: PricingMode;
  /**
   * ADR 023 · true = el admin NO puede cambiar el modo (invariante de dominio: "la ambulancia NO negocia").
   * Las verticales especiales (ambulancia/grúa/mecánico) van locked=true en FIXED. Los viajes (rides) van
   * locked=false → el admin elige Fijo o Puja. Reemplaza el candado que antes daba `allowedModes`.
   */
  modeLocked: boolean;
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
    pricing: { multiplier: 0.55, minFareCents: 300 },
    mode: PricingMode.FIXED,
    modeLocked: false,
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
    pricing: { multiplier: 1.0, minFareCents: 500 },
    mode: PricingMode.FIXED,
    modeLocked: false,
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
    pricing: { multiplier: 1.25, minFareCents: 500 },
    // Confort = auto de gama media o mejor, no muy viejo (BR-D04 ya exige >=2017; esto es más estricto).
    requires: { minSegment: VehicleSegment.MID, maxAgeYears: 8 },
    mode: PricingMode.FIXED,
    modeLocked: false,
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
    pricing: { multiplier: 1.6, minFareCents: 500 },
    // XL = capacidad: 6 asientos o más (familias/grupos). El segmento no importa, sí el tamaño.
    requires: { minSeats: 6 },
    mode: PricingMode.FIXED,
    modeLocked: false,
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
    pricing: { multiplier: 1.8, minFareCents: 800 },
    // Premium = alta gama (segmento PREMIUM) + unidad nueva (<=5 años). La FOTO del vehículo (REQUERIDA
    // para aprobar, ya capturada en onboarding) es la evidencia del operador para asignar segmento PREMIUM.
    // ADR-017 §1.2.
    requires: { minSegment: VehicleSegment.PREMIUM, maxAgeYears: 5 },
    mode: PricingMode.FIXED,
    modeLocked: false,
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
    pricing: { multiplier: 2.5, minFareCents: 3000 },
    // La ambulancia NO negocia (invariante de dominio): solo FIXED.
    mode: PricingMode.FIXED,
    modeLocked: true,
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
    // Grúa: hook-up (banderazo) + por-km, SIN por-minuto (perMinCents:0) — ADR 023 §3.
    pricing: { multiplier: 2.0, minFareCents: 4000, perMinCents: 0 },
    mode: PricingMode.FIXED,
    modeLocked: true,
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
    // Mecánico = CALL-OUT PLANO (ADR 023 §3): una VISITA no es un viaje. perKm=0 (no cobra distancia) Y
    // perMin=0 (la labor no se cotiza — se cobra aparte tras el diagnóstico). La fórmula colapsa a `base`.
    pricing: { multiplier: 1.0, minFareCents: 2000, perKmCents: 0, perMinCents: 0 },
    mode: PricingMode.FIXED,
    modeLocked: true,
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
 * Helper PURO: las clases de vehículo con AL MENOS una oferta `enabled` en la lista dada, ordenadas por
 * el enum `VehicleClass` (mismo criterio/orden que el default estático de abajo). FUENTE ÚNICA del cómputo
 * "qué clase es operable": la consumen TANTO el default ESTÁTICO de código (`OPERABLE_VEHICLE_CLASSES`,
 * aplicado a `resolveCatalog(null)` = todas las ofertas con `enabled = defaultEnabled`) COMO el gate
 * overlay-aware del alta de fleet (aplicado al catálogo EFECTIVO del admin, base ⟕ overlay). Pura y
 * unit-testeable (sin I/O ni catálogo hardcodeado): recibe las ofertas ya resueltas y deriva el set.
 */
export function operableVehicleClasses(
  offerings: readonly { enabled: boolean; vehicleClass: VehicleClass }[],
): VehicleClass[] {
  const enabled = new Set(offerings.filter((o) => o.enabled).map((o) => o.vehicleClass));
  return Object.values(VehicleClass).filter((c) => enabled.has(c));
}

/**
 * Clases de vehículo OPERABLES por DEFAULT de código = aquellas con AL MENOS una oferta habilitada por
 * defecto (`defaultEnabled`). Es el fallback CONSERVADOR de "qué se puede registrar/operar" cuando el
 * catálogo EFECTIVO del admin no está disponible (degradación honesta de fleet). Hoy, con VEO_MOTO y
 * VEO_MECHANIC en `defaultEnabled:false`, el resultado es `[CAR]` → "solo autos". Se deriva con el MISMO
 * helper que el gate overlay-aware (DRY), aplicado a `resolveCatalog(null)` (que resuelve cada oferta con
 * `enabled = defaultEnabled`, sin overlay): UNA sola definición de "operable", dos fuentes (estática /
 * efectiva). El orden sale del enum `VehicleClass`.
 */
export const OPERABLE_VEHICLE_CLASSES: readonly VehicleClass[] = operableVehicleClasses(
  resolveCatalog(null),
);

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

/**
 * ADR 023 · el modo EFECTIVO de una oferta = el pin del admin (si la oferta no está lockeada) o el modo de
 * código. Pura, unit-testeable; la consumen `resolveCatalog`, trip-service (`createTrip`) y el quote del
 * public-bff. Reemplaza `resolveOfferingModeWithPin` (que intersectaba con el schedule/franjas — ADR 011
 * superseded). YA NO hay schedule: el modo es `offering.mode` con la palanca manual del admin encima.
 *  - `modeLocked === true` (verticales especiales): SIEMPRE `offering.mode` — el admin no lo puede cambiar
 *    (invariante: "la ambulancia NO negocia"). Un pin se IGNORA.
 *  - `modeLocked === false` (rides): el `pinnedMode` del admin GANA; sin pin → `offering.mode` (default).
 */
export function effectiveOfferingMode(
  offering: OfferingSpec,
  pinnedMode?: PricingMode,
): PricingMode {
  if (offering.modeLocked) return offering.mode;
  return pinnedMode ?? offering.mode;
}

// ── Catálogo editable en caliente (ADR 013 §1.2, puerta de escape · ADR 023) ─────────────────────
// El código `OFFERINGS` es la BASE inmutable de producto (ids, clase de vehículo, modo/pricing por
// defecto). La DB guarda solo el OVERLAY que el admin edita en caliente (singleton + version + outbox).
// El overlay lleva `enabled`, el `mode` (la PALANCA MANUAL, ADR 023) y overrides de precio por oferta.
// El catálogo EFECTIVO = base ⟕ overlay. YA NO hay schedule/franjas (ADR 011 superseded).

/**
 * Override editable por el admin de UNA oferta (caliente):
 *  - `mode`: la PALANCA MANUAL (ADR 023 §1.1). Cambia el modo de ESTA oferta. Se HONRA solo si la oferta
 *    NO está lockeada (`modeLocked === false`); en una vertical lockeada se IGNORA (la ambulancia no
 *    negocia). `undefined` → sin cambio, manda el `mode` de código. NO hay schedule.
 *  - `multiplier` / `minFareCents`: override de `OfferingPricingPolicy`. `undefined` → el valor de código.
 *  - `baseFareCents` / `perKmCents` / `perMinCents`: overrides de los params por servicio (ADR 023 §3).
 *    `undefined` → el valor de código (que a su vez, si es `undefined`, cae al default global).
 *  La tarifa SIGUE saliendo de la fórmula (distancia/tiempo); estos solo escalan/pisan.
 */
export interface OfferingOverride {
  /** Id de la oferta: un `OfferingId` built-in O un id `custom_*` (el overlay configura ambas · ADR 013). */
  id: string;
  enabled: boolean;
  mode?: PricingMode;
  multiplier?: number;
  minFareCents?: number;
  baseFareCents?: number;
  perKmCents?: number;
  perMinCents?: number;
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
 * Una oferta del catálogo EFECTIVO: la spec base + su estado configurable resuelto. `pricing` y `mode` ya
 * son los EFECTIVOS (base ⟕ override del admin). El `mode` respeta `modeLocked` (un pin sobre una vertical
 * lockeada se ignora); el consumidor usa `mode` directo, no re-resuelve.
 */
export interface ResolvedOffering extends Omit<OfferingSpec, 'id'> {
  /** Built-in → un `OfferingId` del enum; custom → un id `custom_*` de la tabla (string ancho). */
  id: string;
  enabled: boolean;
  /** Nombre display de una oferta CUSTOM (las built-in lo resuelven por `labelKey`). Ausente en built-in. */
  name?: string;
  /** true = oferta CUSTOM (alta del admin, tabla). Ausente/false = built-in del enum de código. */
  isCustom?: boolean;
}

// ── Ofertas CUSTOM (alta del admin · ADR 013 · tabla CustomOffering) ──────────────────────────────
// El enum `OfferingId` es el catálogo built-in INMUTABLE (contrato con la app). Una oferta CUSTOM la crea el
// SUPERADMIN en caliente: vive en la tabla `CustomOffering` de trip-service y EXTIENDE el enum. Restricción
// honesta: una custom mapea a un `vehicleClass`/`serviceType` que YA EXISTE (el dispatch/matching y los
// módulos nativos trabajan por `vehicleClass` — NO se inventa un tipo de vehículo nuevo). El catálogo EFECTIVO
// UNE built-in ∪ custom; el pricing/config per-oferta (overlay del admin) funciona igual para ambas.

/** Prefijo de los ids de oferta CUSTOM. Los built-in son el enum `OfferingId` (jamás llevan este prefijo). */
export const CUSTOM_OFFERING_ID_PREFIX = 'custom_';

/** ¿`id` es el id de una oferta CUSTOM (alta del admin), no un built-in del enum? (chequeo por prefijo). */
export function isCustomOfferingId(id: string): boolean {
  return id.startsWith(CUSTOM_OFFERING_ID_PREFIX);
}

/**
 * Registro de una oferta CUSTOM (la fila de la tabla `CustomOffering`). Es el equivalente al `OfferingSpec` de
 * código para una oferta creada en caliente: guarda su `name`, el `vehicleClass`/`serviceType` existente al que
 * mapea, y su pricing/modo/enabled INICIALES (que el overlay del admin luego puede pisar, igual que a las built-in).
 */
export interface CustomOfferingRecord {
  id: string;
  name: string;
  vehicleClass: VehicleClass;
  serviceType: ServiceType;
  mode: PricingMode;
  multiplier: number;
  minFareCents: number;
  enabled: boolean;
}

/** `sortOrder` base de las ofertas custom: van DESPUÉS de todas las built-in (que llegan hasta ~12). */
export const CUSTOM_OFFERING_SORT_BASE = 100;

/**
 * Proyecta una oferta CUSTOM (fila de la tabla) al shape `ResolvedOffering` del catálogo efectivo, aplicando el
 * overlay del admin con la MISMA mecánica que las built-in (`resolveCatalog`): pricing/mode/enabled = base de la
 * tabla ⟕ override. Una custom NUNCA está `modeLocked` (el admin la creó y le puede cambiar el modo) y su `flow`
 * es STANDARD (mapea a un `vehicleClass` existente; las verticales EMERGENCY son built-in). El ícono deriva del
 * `vehicleClass` (MOTO → moto, CAR → car), nunca del id. `index` fija el desempate del `sortOrder`.
 */
export function customOfferingToResolved(
  record: CustomOfferingRecord,
  override: OfferingOverride | undefined,
  index: number,
): ResolvedOffering {
  const spec: OfferingSpec = {
    id: record.id as OfferingId, // custom id: string; `effectiveOfferingMode` solo lee `mode`/`modeLocked`.
    labelKey: record.name,
    icon: record.vehicleClass === VehicleClass.MOTO ? OfferingIcon.MOTO : OfferingIcon.CAR,
    vehicleClass: record.vehicleClass,
    serviceType: record.serviceType,
    pricing: { multiplier: record.multiplier, minFareCents: record.minFareCents },
    mode: record.mode,
    modeLocked: false,
    flow: OfferingFlow.STANDARD,
    defaultEnabled: record.enabled,
    sortOrder: CUSTOM_OFFERING_SORT_BASE + index,
  };
  const pricing: OfferingPricingPolicy = {
    multiplier: override?.multiplier ?? record.multiplier,
    minFareCents: override?.minFareCents ?? record.minFareCents,
    baseFareCents: override?.baseFareCents,
    perKmCents: override?.perKmCents,
    perMinCents: override?.perMinCents,
  };
  return {
    ...spec,
    id: record.id,
    pricing,
    mode: effectiveOfferingMode(spec, override?.mode),
    enabled: override?.enabled ?? record.enabled,
    name: record.name,
    isCustom: true,
  };
}

/**
 * Catálogo EFECTIVO = `OFFERINGS` (base de código) ⟕ overlay (config DB del admin), en `sortOrder`.
 * Caminos infelices (ADR 013 §2):
 *  - oferta SIN entrada en el overlay → `enabled: true`, pricing/modo de código (no esconder lo shippeado).
 *  - overlay con un id que ya no existe en código → se IGNORA (el código es la fuente de ids válidos).
 *  - overlay `null` (DB vacía/caída) → todas a su `defaultEnabled`, pricing/modo de código (degradación honesta).
 *  - overrides de precio (`multiplier`/`minFareCents`/params) pisan campo a campo; el `mode` pineado se honra
 *    solo si `!modeLocked` (`effectiveOfferingMode`) — en una vertical lockeada se ignora.
 *  - `customs` = ofertas CUSTOM (tabla del admin): se UNEN a las built-in, resueltas con el MISMO overlay
 *    (una custom es configurable igual que una built-in). Ordenadas todas juntas por `sortOrder` (las custom
 *    caen después, `CUSTOM_OFFERING_SORT_BASE`+). Un override con un id que no matchea NINGUNA (built-in ni
 *    custom) se IGNORA — el código/tabla son la fuente de ids válidos (cinturón y tirantes con el DTO).
 */
export function resolveCatalog(
  overlay: OfferingCatalogOverlay | null,
  customs: readonly CustomOfferingRecord[] = [],
): readonly ResolvedOffering[] {
  const overrideById = new Map<string, OfferingOverride>(
    (overlay?.overrides ?? []).map((o) => [o.id, o]),
  );
  const builtin = OFFERING_LIST.map((spec) => {
    const ov = overrideById.get(spec.id);
    const pricing: OfferingPricingPolicy = {
      multiplier: ov?.multiplier ?? spec.pricing.multiplier,
      minFareCents: ov?.minFareCents ?? spec.pricing.minFareCents,
      baseFareCents: ov?.baseFareCents ?? spec.pricing.baseFareCents,
      perKmCents: ov?.perKmCents ?? spec.pricing.perKmCents,
      perMinCents: ov?.perMinCents ?? spec.pricing.perMinCents,
    };
    const mode = effectiveOfferingMode(spec, ov?.mode);
    const resolved: ResolvedOffering = { ...spec, pricing, mode, enabled: ov?.enabled ?? spec.defaultEnabled };
    return resolved;
  });
  const custom = customs.map((rec, i) => customOfferingToResolved(rec, overrideById.get(rec.id), i));
  return [...builtin, ...custom].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Solo las ofertas ACTIVAS (las que el quote cotiza y la teaser del Home muestra). Incluye las custom activas. */
export function activeOfferings(
  overlay: OfferingCatalogOverlay | null,
  customs: readonly CustomOfferingRecord[] = [],
): readonly ResolvedOffering[] {
  return resolveCatalog(overlay, customs).filter((offering) => offering.enabled);
}
