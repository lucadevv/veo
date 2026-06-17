/**
 * Mapa de calor de demanda (lado conductor, Ola 2C). Proxy firmado a dispatch-service
 * (`GET /heatmap`), que agrega la demanda reciente por celda H3.
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { HeatmapView } from '@veo/api-client';
import { RestGateway } from '../infra/rest.gateway';

@Injectable()
export class HeatmapService {
  constructor(private readonly rest: RestGateway) {}

  get(
    identity: AuthenticatedUser,
    lat: number,
    lng: number,
    radius?: number,
  ): Promise<HeatmapView> {
    return this.rest.client('dispatch').get<HeatmapView>('/heatmap', {
      identity,
      query: { lat, lng, radius },
    });
  }
}
