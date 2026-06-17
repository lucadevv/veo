import type {
  DriverIncentive,
  DriverIncentiveList,
  HeatmapCell,
  HeatmapView,
  IncentiveType,
} from '@veo/api-client';

/**
 * Entidades del dominio operativo del conductor (Ola 2C): mapa de calor de demanda e incentivos.
 * Re-exportan los contratos para que la presentación dependa del dominio, no del paquete de API.
 */
export type DemandHeatmap = HeatmapView;
export type DemandCell = HeatmapCell;
export type Incentive = DriverIncentive;
export type IncentiveList = DriverIncentiveList;
export type { IncentiveType };

/** Parámetros de la consulta del mapa de calor: ubicación del conductor + radio en metros. */
export interface HeatmapQuery {
  lat: number;
  lng: number;
  /** Radio de búsqueda en metros. Por defecto el repositorio aplica uno razonable. */
  radius?: number;
}
