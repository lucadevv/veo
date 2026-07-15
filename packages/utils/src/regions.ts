/**
 * Catálogo de REGIONES de Perú para el BROWSE del marketplace de carpool (feed filtrable por región).
 *
 * Los ids son kebab-case ESTABLES: viajan por el wire (query param `region` del browse) y los persisten
 * los clientes — renombrar un id es un breaking change de contrato. Los bbox son APROXIMADOS y curados a
 * mano (envolvente rectangular del departamento / área metropolitana): suficientes para un filtro de feed
 * ("viajes que salen de Arequipa"), NO para geocercas legales. `lima-metropolitana` reusa LIMA_BBOX de
 * geo.ts (la misma envolvente que BR-D03 usa como zona permitida — una sola fuente para "Lima urbana").
 *
 * SOLAPAMIENTO: dos bbox rectangulares pueden solaparse en las esquinas (p. ej. Ica ∩ Arequipa, Lambayeque
 * ∩ Piura) y un área metropolitana vive DENTRO de su departamento (Lima Metropolitana ⊂ depto Lima, si el
 * depto entrara al catálogo). Regla determinista: si un punto cae en 2+ bbox, GANA el de MENOR ÁREA (la
 * región más específica). El área se aproxima en grados² (ΔLat × ΔLon) — sobra para desambiguar envolventes
 * del mismo orden de latitud; a igualdad exacta de área gana el que aparece antes en el catálogo (estable).
 */
import { LIMA_BBOX, type LatLon } from './geo.js';

/** Envolvente rectangular lat/lon (grados WGS84). minLat ≤ maxLat, minLon ≤ maxLon. */
export interface GeoBBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Región del catálogo: id estable de wire (kebab-case) + nombre para mostrar + envolvente aproximada. */
export interface RegionPE {
  id: string;
  nombre: string;
  bbox: GeoBBox;
}

/**
 * Regiones curadas (v1 del marketplace): Lima Metropolitana + los departamentos con las ciudades donde
 * el carpool intercity tiene tracción. Bboxes = envolventes aproximadas del territorio (verificadas contra
 * las ciudades ancla de cada una; ver regions.spec.ts). Agregar una región = agregar una entrada acá —
 * el resto (validación de DTO, filtro del repo, detección del app) la consume del catálogo.
 */
export const REGIONS_PE: readonly RegionPE[] = [
  {
    // Lima + Callao URBANO (área metropolitana), NO el departamento entero: misma envolvente que BR-D03.
    id: 'lima-metropolitana',
    nombre: 'Lima Metropolitana',
    bbox: { ...LIMA_BBOX },
  },
  {
    id: 'arequipa',
    nombre: 'Arequipa',
    bbox: { minLat: -17.3, maxLat: -14.6, minLon: -75.1, maxLon: -70.8 },
  },
  {
    id: 'cusco',
    nombre: 'Cusco',
    bbox: { minLat: -15.45, maxLat: -11.1, minLon: -73.98, maxLon: -70.35 },
  },
  {
    // Trujillo y valle de Moche; el departamento se interna hasta el Marañón.
    id: 'la-libertad',
    nombre: 'La Libertad',
    bbox: { minLat: -9.0, maxLat: -6.85, minLon: -79.7, maxLon: -76.75 },
  },
  {
    id: 'piura',
    nombre: 'Piura',
    bbox: { minLat: -6.4, maxLat: -4.05, minLon: -81.35, maxLon: -79.1 },
  },
  {
    id: 'ica',
    nombre: 'Ica',
    bbox: { minLat: -15.45, maxLat: -12.95, minLon: -76.4, maxLon: -74.65 },
  },
  {
    // Huancayo y el valle del Mantaro; el departamento llega hasta la selva de Satipo.
    id: 'junin',
    nombre: 'Junín',
    bbox: { minLat: -12.75, maxLat: -10.7, minLon: -76.55, maxLon: -73.35 },
  },
  {
    id: 'lambayeque',
    nombre: 'Lambayeque',
    bbox: { minLat: -7.2, maxLat: -5.45, minLon: -80.65, maxLon: -79.1 },
  },
  {
    // Huaraz (sierra) + Chimbote (costa).
    id: 'ancash',
    nombre: 'Áncash',
    bbox: { minLat: -10.8, maxLat: -8.0, minLon: -78.7, maxLon: -76.7 },
  },
];

/** Región por id de wire (kebab-case). Desconocido → undefined (el borde lo convierte en 400). */
export function regionById(id: string): RegionPE | undefined {
  return REGIONS_PE.find((r) => r.id === id);
}

/** ¿El punto cae dentro del bbox (bordes inclusive)? */
function bboxContains(bbox: GeoBBox, lat: number, lon: number): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

/** Área APROXIMADA del bbox en grados² (ΔLat × ΔLon) — solo para desambiguar solapamientos, no es km². */
function bboxAreaDeg2(bbox: GeoBBox): number {
  return (bbox.maxLat - bbox.minLat) * (bbox.maxLon - bbox.minLon);
}

/**
 * Región cuyo bbox contiene el punto (para que el app detecte la región del usuario por su GPS).
 * Si el punto cae en 2+ bbox solapados, gana el de MENOR ÁREA (la región más específica — p. ej. un área
 * metropolitana dentro de su departamento); a igualdad de área, el primero del catálogo (estable).
 * Fuera de todo bbox (mar, región no catalogada) → undefined honesto.
 */
export function regionForPoint(lat: number, lon: number): RegionPE | undefined {
  let best: RegionPE | undefined;
  for (const region of REGIONS_PE) {
    if (!bboxContains(region.bbox, lat, lon)) continue;
    if (best === undefined || bboxAreaDeg2(region.bbox) < bboxAreaDeg2(best.bbox)) {
      best = region;
    }
  }
  return best;
}

/** Azúcar sobre regionForPoint para el shape LatLon de geo.ts. */
export function regionForLatLon(point: LatLon): RegionPE | undefined {
  return regionForPoint(point.lat, point.lon);
}
