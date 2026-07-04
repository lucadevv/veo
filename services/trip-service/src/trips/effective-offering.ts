/**
 * Resolución de la OFERTA EFECTIVA (overlay del admin) — ÚNICA fuente de verdad compartida por todos los sitios
 * que cotizan una tarifa contra el catálogo: createTrip, changeDestination y el re-quote de parada
 * (waypoint-proposal). Antes vivía como método privado de TripsService y waypoint-proposal cotizaba con el
 * `offering.pricing` de CÓDIGO crudo → si el admin editaba el multiplier/minFare de una oferta (overlay), la
 * parada se cobraba a otra tasa que el viaje original (incoherencia create↔waypoint, RC4-waypoint · ADR-022).
 *
 * Devuelve el pricing + pin de modo EFECTIVOS (overlay B2). DEGRADACIÓN HONESTA idéntica al create: sin catálogo
 * (tests legacy / no inyectado) o si la lectura FALLA → usa el pricing de CÓDIGO y PERMITE el viaje (no se bloquea
 * un pedido por una lectura de config caída). Oferta deshabilitada con `enforceEnabled` → OfferingUnavailableError.
 */
import type { OfferingSpec, OfferingPricingPolicy, PricingMode } from '@veo/shared-types';
import type { CatalogService } from '../catalog/catalog.service';
import { OfferingUnavailableError } from './trips.errors';
import { bumpCatalogDegraded, type CatalogDegradedSite } from './trip-metrics';

export interface EffectiveOffering {
  pricing: OfferingPricingPolicy;
  modePin?: PricingMode;
}

export interface ResolveEffectiveOfferingOpts {
  /**
   * `true` (default) en el CREATE: una oferta deshabilitada por el admin → 409 (no se crea). En una re-cotización
   * MID-VIAJE (changeDestination / waypoint) el viaje YA existe con esa oferta: que el admin la deshabilite no
   * puede romper un cambio en curso → `false` trae solo el pricing efectivo SIN el gate de enabled.
   */
  enforceEnabled?: boolean;
  /** Etiqueta BOUNDED del counter de degradación (la fn es COMPARTIDA → la métrica no miente el origen). */
  site?: CatalogDegradedSite;
}

/**
 * Resuelve el pricing/pin EFECTIVOS de una oferta aplicando el overlay del admin. `catalog` nulo/ausente o lectura
 * caída → pricing de código (degradación honesta). `logger` opcional para el warn estructurado del catch.
 */
export async function resolveEffectiveOffering(
  catalog: CatalogService | null | undefined,
  base: OfferingSpec,
  { enforceEnabled = true, site = 'create' }: ResolveEffectiveOfferingOpts = {},
  logger?: { warn: (message: string) => void },
): Promise<EffectiveOffering> {
  if (!catalog) return { pricing: base.pricing };
  let resolved;
  try {
    resolved = await catalog.resolveOffering(base.id);
  } catch (err) {
    // B5-4: las verticales ocultas (defaultEnabled:false) NUNCA se crean, ni en degradación — sin confirmar que el
    // admin las habilitó, permitir una ambulancia/grúa por catálogo caído sería el leak inverso al de la UI. Solo en
    // el create (enforceEnabled): mid-viaje el viaje ya existe, no se re-gatea por catálogo caído.
    if (enforceEnabled && !base.defaultEnabled) throw new OfferingUnavailableError(base.id);
    logger?.warn(
      `catálogo no disponible al resolver '${base.id}' (${(err as Error).message}); ` +
        `uso el pricing de código y permito el viaje (degradación honesta · ADR 013)`,
    );
    bumpCatalogDegraded(site);
    return { pricing: base.pricing };
  }
  if (enforceEnabled && resolved && !resolved.enabled) throw new OfferingUnavailableError(base.id);
  // Sin entrada en el overlay (no debería pasar: el id sale del catálogo de código) → pricing de código.
  if (!resolved) return { pricing: base.pricing };
  return { pricing: resolved.pricing, modePin: resolved.modePin };
}
