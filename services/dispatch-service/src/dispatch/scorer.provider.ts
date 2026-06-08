/**
 * Provee el DispatchScorer construido con los pesos del entorno (BR-T06).
 * Aislado para que el dominio reciba un scorer determinista por DI (testeable por separado).
 */
import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DispatchScorer } from './scoring';
import type { Env } from '../config/env.schema';

export const DISPATCH_SCORER = Symbol('DISPATCH_SCORER');

export const scorerProvider: Provider = {
  provide: DISPATCH_SCORER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): DispatchScorer =>
    new DispatchScorer({
      distance: config.getOrThrow<number>('DISPATCH_W_DISTANCE'),
      rating: config.getOrThrow<number>('DISPATCH_W_RATING'),
      idle: config.getOrThrow<number>('DISPATCH_W_IDLE'),
      cancel: config.getOrThrow<number>('DISPATCH_W_CANCEL'),
    }),
};
