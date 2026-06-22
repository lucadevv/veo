/**
 * Puerto de mapas (FOUNDATION §0.7 soberanía · INTEGRACIONES port+adapter). @veo/maps detrás de un puerto
 * propio intercambiable — el dominio del gate de precio (F1b) habla por el contrato `MapsClient`, NUNCA
 * importa OSRM/HTTP directo. Idéntico patrón a trip-service/dispatch-service.
 *
 * ROUTING SOBERANO (§0.7, regla maestra): SÓLO modos propios self-hosted. Default dev/CI: 'local' (motor
 * determinista propio, sin red). Prod: 'osrm' (infra OSM self-hosted). El adapter 'mapbox' de @veo/maps
 * queda EXCLUIDO A PROPÓSITO — mandaría las coordenadas del viaje a un tercero (violación de soberanía +
 * privacidad Ley 29733). El env (env.schema.ts) ya restringe VEO_MAPS_MODE a SOVEREIGN_MAPS_MODES (sin
 * mapbox), así que este factory NUNCA recibe ese modo. `timeoutMs` (env MAPS_TIMEOUT_MS) acota cada
 * request: si OSRM no responde, el cliente lanza y el gate F1b FALLA-CERRADO (no se publica sin validar).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMapsClient, type MapsClient } from '@veo/maps';
import type { Env } from '../../config/env.schema';

/** Token DI del puerto de mapas. El service depende de ESTE símbolo, no de la clase concreta de @veo/maps. */
export const MAPS_CLIENT = Symbol('MAPS_CLIENT');

const mapsProvider: Provider = {
  provide: MAPS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): MapsClient => {
    const mode = config.getOrThrow<Env['VEO_MAPS_MODE']>('VEO_MAPS_MODE');
    const timeoutMs = config.getOrThrow<number>('MAPS_TIMEOUT_MS');
    if (mode === 'osrm') {
      return createMapsClient({
        mode: 'osrm',
        osrm: {
          osrmBaseUrl: config.getOrThrow<string>('OSRM_BASE_URL'),
          nominatimBaseUrl: config.getOrThrow<string>('NOMINATIM_BASE_URL'),
          // Gate legal FAIL-CLOSED: si OSRM tarda más que esto, la request lanza → no se publica.
          timeoutMs,
        },
      });
    }
    // NO hay branch 'mapbox' a propósito (routing soberano §0.7): el env restringe VEO_MAPS_MODE a
    // local/osrm, así que el modo nunca puede ser mapbox. Ese adapter de @veo/maps queda fuera de booking.
    // 'local' — motor de estimación propio (dev/CI sin red).
    return createMapsClient({ mode: 'local' });
  },
};

@Module({ providers: [mapsProvider], exports: [MAPS_CLIENT] })
export class MapsModule {}
