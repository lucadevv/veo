import type {VehicleModelOption} from '../../domain';

/**
 * Filtro client-side del catálogo de modelos (B5-2): el catálogo es chico, así que la búsqueda del
 * selector se resuelve en memoria sin red por tecla. Matchea por marca O modelo, case-insensitive;
 * query vacía → la lista completa. Pura y testeable (sin RN ni i18n).
 */
export function filterVehicleModels(
  models: readonly VehicleModelOption[],
  query: string,
): VehicleModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...models];
  }
  return models.filter(
    m => m.make.toLowerCase().includes(q) || m.model.toLowerCase().includes(q),
  );
}
