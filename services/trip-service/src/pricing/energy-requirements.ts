/**
 * F2.1b · invariante de COMPLETITUD del catálogo de energía bajo el flip.
 *
 * Cuando PRICING_ENERGY_MODEL_ENABLED=true, CUALQUIER oferta (visible u oculta encendible por overlay)
 * cotiza su tarifa con la energía de su fuente. Si el catálogo no tiene esa fuente, el create autoritativo
 * lanza InvalidStateError. Para que eso NUNCA pase en producción, dos guardas comparten ESTA fuente única de
 * "qué exige el flip" (TODAS las fuentes referenciadas, ver `requiredEnergySources` — no solo las visibles):
 *   - el boot-guard (al arranque, contra el catálogo persistido) — energy-model-boot.guard.ts
 *   - el replace() del catálogo (en el PUT del admin, contra los `sources` entrantes) — energy-catalog.service.ts
 * Así un PUT del admin no puede dejar el catálogo incompleto con el flip activo (evita la caída de creación).
 */
import { OFFERING_LIST, type EnergySource, type OfferingSpec } from '@veo/shared-types';
import { InvalidStateError } from '@veo/utils';
import { authoritativeEnergyPerKmCents } from '../trips/domain/fare';

/** Mínima superficie de lectura del catálogo (no acopla este helper a la clase infra EnergyCatalogService). */
export interface EnergyPriceLookup {
  getPriceFor(source: EnergySource): Promise<number | null>;
}

/**
 * F2.1b · resuelve el costo de energía por km AUTORITATIVO (flip ON) leyendo el precio del catálogo. Glue
 * compartido por createTrip, changeDestination y el re-quote de parada — los tres caminos que cotizan una
 * tarifa firme. Catálogo ausente o fuente sin precio → InvalidStateError (nunca cobra de menos en silencio,
 * vía la fn pura de dominio). Una sola implementación: ningún camino de cotización puede olvidar la energía.
 */
export async function resolveAuthoritativeEnergy(
  catalog: EnergyPriceLookup | null | undefined,
  offering: OfferingSpec,
): Promise<number> {
  if (!catalog) {
    throw new InvalidStateError('Modelo de energía activo pero el catálogo no está disponible', {
      offering: offering.id,
    });
  }
  const price = await catalog.getPriceFor(offering.referenceEnergySourceId);
  return authoritativeEnergyPerKmCents(offering, price);
}

/**
 * Fuentes de energía que el flip exige pobladas: TODA fuente referenciada por CUALQUIER oferta del catálogo
 * (NO solo las visibles). Razón: el admin puede ENCENDER una vertical oculta por overlay (ambulancia/grúa =
 * DIESEL) en runtime; si su fuente no estuviera exigida, el create autoritativo (flip+FIXED) lanzaría
 * InvalidStateError → outage del flujo de emergencia. Exigir todas las fuentes referenciadas garantiza que
 * encender cualquier vertical luego sea seguro. Hoy son {GASOLINE_90 (RIDE), DIESEL (ambulancia/grúa)}; el
 * panel de energía ya ofrece las 3 fuentes, así que poblarlas antes del flip no agrega fricción real.
 */
export function requiredEnergySources(): Set<EnergySource> {
  return new Set(OFFERING_LIST.map((o) => o.referenceEnergySourceId));
}

/**
 * Fuentes requeridas que NO están en `present` (el conjunto de fuentes con precio cargado). `[]` = catálogo
 * completo para el flip. `present` se construye distinto en cada guarda (catálogo persistido vs lista
 * entrante), pero el set requerido es el MISMO — una sola definición de la regla.
 */
export function missingRequiredSources(present: ReadonlySet<EnergySource>): EnergySource[] {
  return [...requiredEnergySources()].filter((src) => !present.has(src));
}
