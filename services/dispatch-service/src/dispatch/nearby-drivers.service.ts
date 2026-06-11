/**
 * NearbyDriversService — feed de "taxis cercanos en vivo" para el MAPA del pasajero mientras busca.
 *
 * Es un concern DISTINTO al matching (MatchingService orquesta ofertas/scoring/timeout): acá es una
 * LECTURA de AMBIENTE del hot-index para pintar autitos en el mapa ("estás acá, hay autos cerca").
 * Por eso vive en su propio service (SRP) y solo depende del puerto HOT_INDEX (DIP), no de Redis.
 *
 * PRIVACIDAD (seguridad = diferenciador de VEO): la respuesta es ANÓNIMA — SOLO {lat, lon, vehicleType}.
 * NUNCA driverId/nombre/rating (los autitos son AMBIENTE, no identidades asignables). Además las coords
 * se REDONDEAN (~110m) para frenar el rastreo fino de la trayectoria de un auto entre polls sucesivos.
 *
 * COSTO ACOTADO (hot-path · se pollea/emite seguido): NO usa `candidates()` (que trae TODO el set de la
 * celda para que el matching rankee) sino `availableSample(cells, limit)`, que muestrea a lo sumo
 * `SAMPLE_LIMIT` en Redis. Para un feed de ambiente NO hacen falta los 30 EXACTOS más cercanos: alcanza
 * una muestra representativa. Así el costo Redis+CPU queda acotado, no escala con la densidad de la zona.
 */
import { Inject, Injectable } from '@nestjs/common';
import { toH3, neighbors, distanceMeters, isWithinLima, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import { domainEventsTotal, createLogger, type Logger } from '@veo/observability';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';

/** Conductor cercano ANÓNIMO (lo único que el pasajero ve en el mapa de "buscando"). */
export interface NearbyDriver {
  lat: number;
  lon: number;
  vehicleType: VehicleClass;
}

/** Muestra máxima a traer de Redis (acota el costo del hot-path; ver header). */
const SAMPLE_LIMIT = 60;
/** Tope de autitos devueltos al cliente (de la muestra, los más cercanos primero). */
const MAX_NEARBY = 30;
/** Precisión de las coords devueltas (3 decimales ≈ 110m): anti-rastreo de trayectoria. */
const COORD_DECIMALS = 3;

const round = (n: number): number => {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(n * f) / f;
};

const VEHICLE_CLASSES = new Set<string>(Object.values(VehicleClass));

@Injectable()
export class NearbyDriversService {
  private readonly logger: Logger = createLogger('dispatch:nearby-drivers');

  constructor(
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    private readonly radiusConfig: DispatchRadiusConfigService,
  ) {}

  /**
   * Conductores disponibles cerca del `origin`, anónimos, ordenados por cercanía y capeados.
   * `vehicleType` (opcional): si es un tipo VÁLIDO filtra por él; si es inválido o ausente, devuelve
   * todos los tipos (NUNCA un mapa vacío silencioso por un valor basura del cliente).
   */
  async nearby(origin: LatLon, vehicleType?: string): Promise<NearbyDriver[]> {
    // #3 — borde no confiable: coords fuera de Lima / NaN no consultan el índice (isWithinLima ya
    // descarta NaN: toda comparación con NaN es false). Degradación honesta: devolvemos vacío, no crash.
    if (!isWithinLima(origin)) {
      domainEventsTotal.inc({ event: 'dispatch.nearby_drivers', result: 'invalid' });
      this.logger.warn({ lat: origin.lat, lon: origin.lon }, 'nearby: origen inválido/fuera de Lima → vacío');
      return [];
    }
    // vehicleType del cliente: solo se respeta si es un valor REAL del enum; si no, se ignora (todos).
    const vt = vehicleType && VEHICLE_CLASSES.has(vehicleType) ? (vehicleType as VehicleClass) : undefined;

    const startedAt = Date.now();
    // Radio del feed EDITABLE en runtime por el admin (config singleton, cacheado). Sin config → DEFAULT.
    const { nearbyKRing } = await this.radiusConfig.getKRings();
    const cells = neighbors(toH3(origin, DISPATCH_H3_RESOLUTION), nearbyKRing);
    const sample = await this.hotIndex.availableSample(cells, SAMPLE_LIMIT);
    const byType = vt ? sample.filter((l) => l.vehicleType === vt) : sample;
    const out = byType
      .map((l) => ({ lat: l.lat, lon: l.lon, vehicleType: l.vehicleType, d: distanceMeters(l, origin) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_NEARBY)
      .map(({ lat, lon, vehicleType: t }) => ({ lat: round(lat), lon: round(lon), vehicleType: t }));

    // #2 — observabilidad del hot-path: métrica de resultado + log estructurado con latencia y señal de
    // densidad (`capped`=la muestra tocó el tope → zona saturada, a vigilar para subir SAMPLE_LIMIT o
    // afinar el k-ring). El tracing del span lo aporta la auto-instrumentación OTEL del servicio.
    domainEventsTotal.inc({ event: 'dispatch.nearby_drivers', result: 'ok' });
    this.logger.debug(
      {
        sampled: sample.length,
        returned: out.length,
        capped: sample.length >= SAMPLE_LIMIT,
        vehicleType: vt ?? 'all',
        durationMs: Date.now() - startedAt,
      },
      'nearby drivers',
    );
    return out;
  }
}
