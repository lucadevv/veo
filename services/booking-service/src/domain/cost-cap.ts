/**
 * F1b — TOPE de cost-sharing por distancia (ADR-014 §8 · VEO_MODELO_HIBRIDO §8 · ESCUDO LEGAL anti-lucro).
 *
 * PORQUÉ EXISTE: VEO es CARPOOLING (compartir costos), NO taxi informal. La oferta del conductor debe
 * COMPARTIR el costo del viaje, no LUCRAR. El tope acota el precio del asiento a una fracción del costo
 * real del trayecto: `precio_asiento ≤ (distancia_km × costo/km) / asientosTotales`. Server-side, NO
 * negociable por el cliente — un precio por encima del tope se RECHAZA al publicar/editar.
 *
 * Este módulo es DOMINIO PURO: la MATEMÁTICA del tope, sin I/O. Las distancias (metros) entran como dato
 * (las calcula el `CostCapService` vía el puerto `MapsClient`). Así el cálculo es determinista y testeable
 * sin red, y el dominio NUNCA importa OSRM/HTTP (INTEGRACIONES port+adapter).
 *
 * DINERO SIEMPRE EN CÉNTIMOS Int: el tope se redondea con Math.floor (un único redondeo, sobre el tope, no
 * sobre intermedios) — el resultado comparado/persistido es entero, SIN float. Se redondea HACIA ABAJO
 * (floor, NO round) a propósito: el tope es un MÁXIMO legal (el costo-compartido real); round concedería
 * hasta ~0.5 céntimo por encima del costo en los casos .5 → micro-lucro. El tope nunca debe EXCEDER el
 * costo real, así que se trunca: `precio ≤ floor(costoReal)`.
 */
import { ValidationError } from '@veo/utils';

/**
 * País del marketplace. NO existe enum tipado en @veo/shared-types (verificado: no hay Pais/Country/
 * CountryCode). Se fija la constante TIPADA local — CERO strings mágicos 'PE'/'EC' sueltos en la lógica.
 * El `pais` persistido en PublishedTrip es String; este tipo lo NARROWS al conjunto soportado (PE → F1, EC → F8).
 */
export const PAIS = {
  PE: 'PE',
  EC: 'EC',
} as const;

export type Pais = (typeof PAIS)[keyof typeof PAIS];

export function isPais(value: string): value is Pais {
  return value === PAIS.PE || value === PAIS.EC;
}

/** Costo/km por país (céntimos Int), provisto desde env (PROVISIONAL, validado por legal/finanzas). */
export interface CostPerKmConfig {
  readonly [PAIS.PE]: number;
  readonly [PAIS.EC]: number;
}

/**
 * Resuelve el costo/km (céntimos) para un país. País no soportado → ValidationError tipado (no un default
 * silencioso: publicar para un país sin tarifa configurada es un estado inválido, no un fallback).
 */
export function costPerKmCentsFor(pais: string, config: CostPerKmConfig): number {
  if (!isPais(pais)) {
    throw new ValidationError('País no soportado para el cálculo del tope de cost-sharing', { pais });
  }
  return config[pais];
}

/**
 * Tope (céntimos Int) de un trayecto dado su distancia. FÓRMULA ÚNICA (full-route y por tramo la comparten):
 *
 *   topeCentimos = Math.floor((distanceMeters / 1000) * costPerKmCents / asientosTotales)
 *
 * Un único Math.floor sobre el resultado final → entero, sin float persistido/comparado, y SIEMPRE ≤ costo
 * real (un tope nunca debe exceder el costo-compartido). `asientosTotales` reparte el costo del trayecto
 * entre los asientos (cada pasajero paga su fracción, no el viaje entero).
 */
export function capCentsForDistance(
  distanceMeters: number,
  costPerKmCents: number,
  asientosTotales: number,
): number {
  if (asientosTotales <= 0) {
    // Defensa en profundidad: el publish ya exige asientosTotales > 0; acá evita división por cero.
    throw new ValidationError('asientosTotales debe ser mayor a 0 para calcular el tope', {
      asientosTotales,
    });
  }
  const distanceKm = distanceMeters / 1000;
  // floor (NO round): el tope es un MÁXIMO legal; truncar garantiza tope ≤ costo real (anti micro-lucro .5).
  return Math.floor((distanceKm * costPerKmCents) / asientosTotales);
}

/**
 * Verifica el tope FULL-ROUTE: el `precioBase` (asiento de la ruta completa) no puede exceder el tope
 * derivado de la distancia origen→destino (con stopovers como waypoints). Excede → ValidationError con la
 * causa concreta (precio, tope, distancia) para un 400 legible.
 */
export function assertFullRouteCap(args: {
  precioBaseCentimos: number;
  distanceMeters: number;
  costPerKmCents: number;
  asientosTotales: number;
}): void {
  const tope = capCentsForDistance(args.distanceMeters, args.costPerKmCents, args.asientosTotales);
  if (args.precioBaseCentimos > tope) {
    throw new ValidationError(
      'El precio base excede el tope de cost-sharing por distancia (carpooling no puede lucrar)',
      {
        precioBaseCentimos: args.precioBaseCentimos,
        topeCentimos: tope,
        distanceMeters: args.distanceMeters,
        costPerKmCents: args.costPerKmCents,
        asientosTotales: args.asientosTotales,
      },
    );
  }
}

/**
 * Verifica el tope de UN tramo: el precio del tramo [desdeOrden→hastaOrden] no puede exceder el tope
 * derivado de la distancia de ESE segmento. Excede → ValidationError con la causa (incluye los órdenes del
 * tramo para que el conductor sepa CUÁL tramo está fuera de rango).
 */
export function assertTramoCap(args: {
  desdeOrden: number;
  hastaOrden: number;
  precioCentimos: number;
  distanceMeters: number;
  costPerKmCents: number;
  asientosTotales: number;
}): void {
  const tope = capCentsForDistance(args.distanceMeters, args.costPerKmCents, args.asientosTotales);
  if (args.precioCentimos > tope) {
    throw new ValidationError(
      'El precio de un tramo excede el tope de cost-sharing por distancia',
      {
        desdeOrden: args.desdeOrden,
        hastaOrden: args.hastaOrden,
        precioCentimos: args.precioCentimos,
        topeCentimos: tope,
        distanceMeters: args.distanceMeters,
        costPerKmCents: args.costPerKmCents,
        asientosTotales: args.asientosTotales,
      },
    );
  }
}
