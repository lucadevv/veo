/**
 * RadarPreviewService — vista de PLANNING de la densidad REAL de conductores por anillo para la política
 * de despacho configurada. Lo consume el dashboard admin (via BFF) para calibrar los radios de la v2.
 *
 * REUTILIZA el hot-index (HOT_INDEX.candidates) — NO agrega una estructura espacial nueva (regla del task).
 * `driverCount` por anillo = tamaño de `candidates(neighbors(centerCell, k))` (disponibles reales en el
 * disco H3 de radio k). Como los discos gridDisk ACUMULAN, la cuenta es monotónica y el anillo más ancho
 * es el total en rango. Trabajo ACOTADO: dedup por k-ring + tope MAX_PREVIEW_RINGS. Honesto 0 sin conductores.
 *
 * Política:
 *  - v2: FIXED → pasos km initial→increment→max; PUJA → único radio broadcastRadiusKm.
 *  - v1 (o v2 malformado/degradado): un único anillo al k-ring VIGENTE (matchKRing) — muestra el radio que
 *    HOY está en efecto, honesto (v1 no razona en km; se reporta el k-ring crudo convertido a ~km).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  toH3,
  neighbors,
  isWithinLima,
  DISPATCH_H3_RESOLUTION,
  type LatLon,
} from '@veo/utils';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import {
  radiusKmToKRing,
  fixedKmSteps,
  round1,
  REACH_KM_PER_RING,
  MAX_POLICY_K_RING,
} from './dispatch-policy';
import type { DriverLocation } from '../hot-index/hot-index.port';
import type {
  RadarPreviewMode,
  RadarPreviewResponse,
  RadarPreviewRing,
  RadarDriverPosition,
} from './dto/radar-preview.dto';

/** Tope de anillos evaluados (acota el nº de SUNIONs a Redis; cada anillo = 1 candidates()). */
const MAX_PREVIEW_RINGS = MAX_POLICY_K_RING;

/** Tope de la MUESTRA de posiciones ploteables (capa el payload al mapa del admin; no es un ranking). */
const MAX_DRIVER_SAMPLE = 100;

@Injectable()
export class RadarPreviewService {
  constructor(
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    private readonly radiusConfig: DispatchRadiusConfigService,
  ) {}

  async preview(mode: RadarPreviewMode, center: LatLon): Promise<RadarPreviewResponse> {
    // Borde no confiable: centro fuera de Lima / NaN → 0 anillos honestos (no consulta el índice, no crashea).
    if (!isWithinLima(center)) {
      return { mode, center, rings: [], totalInRange: 0, drivers: [] };
    }
    const policy = await this.radiusConfig.getPolicy();
    const useV2 = policy.policyVersion === 'v2' && policy.v2 !== null;

    // Radios (km) a evaluar según modo + política.
    let radiiKm: number[];
    if (mode === 'FIXED') {
      radiiKm = useV2
        ? fixedKmSteps(policy.v2!.FIXED, MAX_PREVIEW_RINGS)
        : [this.kRingToKm((await this.radiusConfig.getKRings()).matchKRing)];
    } else {
      radiiKm = useV2
        ? [policy.v2!.PUJA.broadcastRadiusKm]
        : [this.kRingToKm((await this.radiusConfig.getKRings()).matchKRing)];
    }

    const centerCell = toH3(center, DISPATCH_H3_RESOLUTION);
    const rings: RadarPreviewRing[] = [];
    // Candidatos del anillo MÁS ANCHO evaluado (los discos gridDisk acumulan → el disco más ancho ⊇ los
    // internos). Como `radiiKm` es ascendente, la ÚLTIMA pasada que empuja un anillo es la más ancha; guardamos
    // sus candidatos para derivar de ahí la muestra de posiciones ploteables (reusa lo ya materializado, sin
    // una consulta extra al hot-index).
    let widestCandidates: DriverLocation[] = [];
    let lastK = -1;
    for (const km of radiiKm) {
      if (rings.length >= MAX_PREVIEW_RINGS) break;
      const kRing = radiusKmToKRing(km);
      // Dedup por k-ring: varios pasos de km pueden mapear al MISMO k (increment < 0.3km) → una sola SUNION.
      if (kRing === lastK) continue;
      lastK = kRing;
      const candidates = await this.hotIndex.candidates(neighbors(centerCell, kRing));
      widestCandidates = candidates;
      rings.push({ radiusKm: round1(km), kRing, driverCount: candidates.length });
    }

    // totalInRange = cuenta del anillo más ANCHO (los discos acumulan → es el total dentro del radio máximo).
    const totalInRange = rings.length > 0 ? rings[rings.length - 1]!.driverCount : 0;
    return { mode, center, rings, totalInRange, drivers: this.sampleDrivers(widestCandidates) };
  }

  /**
   * MUESTRA de posiciones reales para el mapa: dedupea por `driverId` (el hot-index ya trae una loc por
   * conductor, pero el dedupe es defensa en profundidad) y CAPA a MAX_DRIVER_SAMPLE (el payload al admin no
   * es un ranking — es un plot de marcadores; no hace falta mandar miles). Solo lat/lon (sin PII).
   */
  private sampleDrivers(candidates: DriverLocation[]): RadarDriverPosition[] {
    const seen = new Set<string>();
    const out: RadarDriverPosition[] = [];
    for (const c of candidates) {
      if (out.length >= MAX_DRIVER_SAMPLE) break;
      if (seen.has(c.driverId)) continue;
      seen.add(c.driverId);
      out.push({ lat: c.lat, lon: c.lon });
    }
    return out;
  }

  /** k-ring crudo (v1) → radio aproximado en km (~0.3km por anillo) para reportarlo homogéneo con la v2. */
  private kRingToKm(kRing: number): number {
    return round1(kRing * REACH_KM_PER_RING);
  }
}
