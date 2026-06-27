/**
 * F1b — TOPE de cost-sharing por distancia (ADR-014 §8 · VEO_MODELO_HIBRIDO §8 · ESCUDO LEGAL anti-lucro).
 *
 * PORQUÉ EXISTE: VEO es CARPOOLING (compartir costos), NO taxi informal. La oferta del conductor debe
 * COMPARTIR el costo del viaje, no LUCRAR. El tope acota el precio del asiento a una fracción del costo
 * real del trayecto, modelo BlaBlaCar: `precio_asiento ≤ (distancia_km × costo/km + peaje) / asientosTotales`.
 * Server-side, NO negociable por el cliente — un precio por encima del tope se RECHAZA al publicar/editar.
 *
 * EL COSTO/KM es el costo de OPERACIÓN real (combustible + desgaste/depreciación, estilo "IRS mileage rate"):
 * lo fija el ADMIN por país (CostPerKmConfig), NO se deriva del precio de energía. El PEAJE (`tollsCents`) lo
 * declara el CONDUCTOR por viaje; se SUMA al costo del trayecto y RECIÉN se divide entre asientos (es un costo
 * del viaje entero, NO un costo por km).
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
 * Techo de CORDURA del peaje declarado por el conductor (céntimos PEN). NO es un valor de negocio fino: es un
 * guard anti-absurdo (fat-finger / overflow / inflado grosero). S/500 cubre con holgura el peaje real de la
 * ruta interurbana más larga del Perú (varias casetas). El tope de cost-sharing limita igual el precio final;
 * este techo solo acota cuánto puede MOVER el conductor el tope al declarar peaje. El DTO lo enforça en el
 * borde; el dominio lo re-valida (defensa en profundidad).
 */
export const MAX_TOLLS_CENTS = 50_000;

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

/**
 * Costo/km por país (céntimos Int) de FALLBACK desde env. La FUENTE AUTORITATIVA del costo/km es la config
 * editable por el admin (CostPerKmConfig en DB, per-país); este objeto solo alimenta la DEGRADACIÓN HONESTA
 * (config no disponible → env) — NUNCA es el valor de primera mano del tope legal.
 */
export interface CostPerKmConfig {
  readonly [PAIS.PE]: number;
  readonly [PAIS.EC]: number;
}

/**
 * Resuelve el costo/km (céntimos) de FALLBACK para un país desde el objeto de env. País no soportado →
 * ValidationError tipado (no un default silencioso: publicar para un país sin tarifa configurada es un estado
 * inválido, no un fallback). Lo usa el resolutor de config como red de degradación, no el cálculo directo.
 */
export function costPerKmCentsFor(pais: string, config: CostPerKmConfig): number {
  if (!isPais(pais)) {
    throw new ValidationError('País no soportado para el cálculo del tope de cost-sharing', { pais });
  }
  return config[pais];
}

/**
 * Tope (céntimos Int) de un trayecto dado su distancia + peaje. FÓRMULA ÚNICA (BlaBlaCar):
 *
 *   topeCentimos = Math.floor((distanceMeters / 1000) * costPerKmCents + tollsCents) / asientosTotales)
 *
 * El PEAJE (`tollsCents`) se SUMA al costo del trayecto (distancia × costo/km) y RECIÉN se divide entre los
 * asientos — es un costo del viaje ENTERO, no un costo por km (NO va en el per-km). Un único Math.floor sobre
 * el resultado final → entero, sin float persistido/comparado, y SIEMPRE ≤ costo real (un tope nunca debe
 * exceder el costo-compartido). `asientosTotales` reparte el costo del trayecto entre los asientos (cada
 * pasajero paga su fracción, no el viaje entero).
 */
export function capCentsForDistance(
  distanceMeters: number,
  costPerKmCents: number,
  asientosTotales: number,
  tollsCents: number,
): number {
  if (asientosTotales <= 0) {
    // Defensa en profundidad: el publish ya exige asientosTotales > 0; acá evita división por cero.
    throw new ValidationError('asientosTotales debe ser mayor a 0 para calcular el tope', {
      asientosTotales,
    });
  }
  if (!Number.isInteger(tollsCents) || tollsCents < 0) {
    // Defensa en profundidad: el DTO ya exige Int ≥ 0; un peaje negativo/no-entero es un estado inválido
    // (no se silencia a 0: publicar/editar con un peaje corrupto debe fallar, no validar un tope torcido).
    throw new ValidationError('El peaje (tollsCents) debe ser un entero ≥ 0', { tollsCents });
  }
  const distanceKm = distanceMeters / 1000;
  // floor (NO round): el tope es un MÁXIMO legal; truncar garantiza tope ≤ costo real (anti micro-lucro .5).
  return Math.floor((distanceKm * costPerKmCents + tollsCents) / asientosTotales);
}

/**
 * Verifica el tope FULL-ROUTE: el `precioBase` (asiento de la ruta completa) no puede exceder el tope
 * derivado de la distancia origen→destino (con stopovers como waypoints) MÁS el peaje declarado del viaje.
 * El peaje entra SOLO acá (es un costo del viaje entero); los tramos no lo cargan (ver `assertTramoCap`).
 * Excede → ValidationError con la causa concreta (precio, tope, distancia, peaje) para un 400 legible.
 */
export function assertFullRouteCap(args: {
  precioBaseCentimos: number;
  distanceMeters: number;
  costPerKmCents: number;
  asientosTotales: number;
  tollsCents: number;
}): void {
  const tope = capCentsForDistance(
    args.distanceMeters,
    args.costPerKmCents,
    args.asientosTotales,
    args.tollsCents,
  );
  if (args.precioBaseCentimos > tope) {
    throw new ValidationError(
      'El precio base excede el tope de cost-sharing por distancia (carpooling no puede lucrar)',
      {
        precioBaseCentimos: args.precioBaseCentimos,
        topeCentimos: tope,
        distanceMeters: args.distanceMeters,
        costPerKmCents: args.costPerKmCents,
        asientosTotales: args.asientosTotales,
        tollsCents: args.tollsCents,
      },
    );
  }
}

/**
 * Verifica el tope FULL-ROUTE aplicado al PRECIO ACORDADO de un booking (precioBase + specialRequest) — el
 * ESCUDO anti-lucro F1b llevado al momento de RESERVAR, no solo al publicar. `precioAcordadoCentimos` es el
 * monto POR ASIENTO que el conductor recibe (en F0 el precio es full-route; el pricing por tramo es F1): no
 * puede exceder el tope full-route, ni siquiera por el `specialRequest` que el pasajero suma al reservar. El
 * peaje del viaje entra acá (es full-route, costo del viaje entero ÷ asientos), igual que en `assertFullRouteCap`.
 * Excede → ValidationError tipado con la causa concreta (para un 400 legible y auditable). Hermano de
 * `assertFullRouteCap`, con su PROPIO mensaje: la causa es el specialRequest del booking, no el precioBase.
 */
export function assertAgreedPriceCap(args: {
  precioAcordadoCentimos: number;
  distanceMeters: number;
  costPerKmCents: number;
  asientosTotales: number;
  tollsCents: number;
}): void {
  const tope = capCentsForDistance(
    args.distanceMeters,
    args.costPerKmCents,
    args.asientosTotales,
    args.tollsCents,
  );
  if (args.precioAcordadoCentimos > tope) {
    throw new ValidationError(
      'El precio acordado (base + specialRequest) excede el tope de cost-sharing por distancia (carpooling no puede lucrar ni vía specialRequest)',
      {
        precioAcordadoCentimos: args.precioAcordadoCentimos,
        topeCentimos: tope,
        distanceMeters: args.distanceMeters,
        costPerKmCents: args.costPerKmCents,
        asientosTotales: args.asientosTotales,
        tollsCents: args.tollsCents,
      },
    );
  }
}

/**
 * Verifica el tope de UN tramo: el precio del tramo [desdeOrden→hastaOrden] no puede exceder el tope
 * derivado de la distancia de ESE segmento (+ peaje SOLO si el tramo es la ruta COMPLETA). Excede →
 * ValidationError con la causa (incluye los órdenes del tramo para que el conductor sepa CUÁL está fuera de rango).
 *
 * EL PEAJE solo entra cuando el tramo ABARCA todo el viaje (origen→destino): ese tramo ES la ruta completa,
 * así que carga el peaje igual que el full-route (de hecho, el tramo full-route implícito == precioBase). Un
 * sub-segmento estricto NO carga el peaje (`tollsCents = 0`): sumarle el peaje de TODO el viaje inflaría su
 * tope (un tramo corto con el peaje entero) → vector de lucro. Quién es "full-route" lo decide el orquestador
 * (CostCapService) y lo pasa acá; el dominio solo aplica la fórmula con el peaje que recibe.
 */
export function assertTramoCap(args: {
  desdeOrden: number;
  hastaOrden: number;
  precioCentimos: number;
  distanceMeters: number;
  costPerKmCents: number;
  asientosTotales: number;
  tollsCents: number;
}): void {
  const tope = capCentsForDistance(
    args.distanceMeters,
    args.costPerKmCents,
    args.asientosTotales,
    args.tollsCents,
  );
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
        tollsCents: args.tollsCents,
      },
    );
  }
}
