/**
 * DispatchModeRegistry — resuelve la DispatchModeStrategy por modo (Map modo→strategy). Es el ÚNICO
 * lugar que conoce el conjunto de modos: agregar uno nuevo = una clase Strategy + una línea acá, sin
 * tocar createTrip / reassign / activateScheduledTrip.
 *
 * forMode() LANZA si el modo no tiene strategy: un modo nuevo sin implementar FALLA FUERTE (no cae
 * silenciosamente en la rama PUJA, como pasaba con los `if FIXED else PUJA`).
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricingMode } from '@veo/shared-types';
import type { DispatchModeStrategy } from './dispatch-mode.strategy';
import { PujaDispatchStrategy } from './puja-dispatch.strategy';
import { FixedDispatchStrategy } from './fixed-dispatch.strategy';
import type { Env } from '../../config/env.schema';

const DEFAULT_BID_WINDOW_SEC = 60;

@Injectable()
export class DispatchModeRegistry {
  private readonly strategies: ReadonlyMap<PricingMode, DispatchModeStrategy>;

  constructor(@Optional() config?: ConfigService<Env, true>) {
    const bidWindowSec = config?.get('BID_WINDOW_SEC', { infer: true }) ?? DEFAULT_BID_WINDOW_SEC;
    const all: DispatchModeStrategy[] = [
      new PujaDispatchStrategy(bidWindowSec),
      new FixedDispatchStrategy(),
    ];
    this.strategies = new Map(all.map((s) => [s.mode, s]));
  }

  forMode(mode: PricingMode): DispatchModeStrategy {
    const strategy = this.strategies.get(mode);
    if (!strategy) {
      throw new Error(`No hay DispatchModeStrategy registrada para el modo de despacho "${mode}"`);
    }
    return strategy;
  }
}
