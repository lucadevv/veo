import {HttpClient, driverIncentiveList, heatmapView} from '@veo/api-client';
import type {
  DemandHeatmap,
  HeatmapQuery,
  IncentiveList,
  OpsRepository,
} from '../../domain';

/** Radio por defecto (m) del mapa de calor si el llamador no especifica uno. */
const DEFAULT_HEATMAP_RADIUS = 3000;

/** Implementación HTTP del `OpsRepository` contra el driver-bff. */
export class HttpOpsRepository implements OpsRepository {
  constructor(private readonly http: HttpClient) {}

  getHeatmap(query: HeatmapQuery): Promise<DemandHeatmap> {
    return this.http.get('/heatmap', {
      query: {
        lat: query.lat,
        lng: query.lng,
        radius: query.radius ?? DEFAULT_HEATMAP_RADIUS,
      },
      schema: heatmapView,
    });
  }

  listIncentives(): Promise<IncentiveList> {
    return this.http.get('/incentives', {schema: driverIncentiveList});
  }
}
