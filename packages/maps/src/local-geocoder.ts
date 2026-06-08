/**
 * Geocoder soberano sobre el dataset curado de Lima (`LIMA_PLACES`). Sin red, determinista.
 *
 * Resuelve geocode (texto → mejor lugar), autocomplete (texto parcial → top-N sesgado por proximidad)
 * y reverse (punto → lugar más cercano). Lo usa `LocalMapsEngine` en dev/CI (`VEO_MAPS_MODE=local`).
 *
 * Algoritmo de match (determinista):
 *  1. Normaliza query y campos buscables (minúsculas, sin tildes, sin signos, espacios colapsados).
 *  2. Tokeniza la query; cada token debe matchear ALGÚN campo buscable (name, district, aliases) por
 *     prefijo de palabra o substring → así "jockey plaza surco" sigue resolviendo Jockey Plaza.
 *  3. Puntúa cada candidato: prefijo exacto del nombre > prefijo de palabra > substring. Si viene
 *     `near`, se desempata/pondera por proximidad (más cerca = mejor) sin filtrar duro.
 */
import { distanceMeters, type LatLon } from '@veo/utils';
import type { GeocodeResult } from './types.js';
import { LIMA_PLACES, placeDisplayName, type LimaPlace } from './data/lima-places.js';

/** Normaliza texto para comparación: minúsculas, sin diacríticos, alfanumérico + espacios colapsados. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes/diacríticos (combining marks, ASCII-safe)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // signos → espacio
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto buscable de un lugar (nombre + distrito + aliases), normalizado. */
function searchableText(place: LimaPlace): string {
  return normalizeText([place.name, place.district, ...(place.aliases ?? [])].join(' '));
}

interface IndexedPlace {
  place: LimaPlace;
  /** Texto buscable normalizado (name + district + aliases). */
  haystack: string;
  /** Nombre normalizado, para puntuar el prefijo exacto del título. */
  name: string;
  /** Palabras únicas del haystack, para el match por prefijo de palabra. */
  words: readonly string[];
}

/** Índice precomputado del dataset (se construye una vez; el dataset es estático). */
const INDEX: readonly IndexedPlace[] = LIMA_PLACES.map((place) => {
  const haystack = searchableText(place);
  return {
    place,
    haystack,
    name: normalizeText(place.name),
    words: Array.from(new Set(haystack.split(' ').filter(Boolean))),
  };
});

/** Mapea un lugar del dataset al contrato `GeocodeResult` (igual shape que el adapter OSRM/Nominatim). */
function toGeocodeResult(place: LimaPlace): GeocodeResult {
  return {
    lat: place.lat,
    lon: place.lon,
    displayName: placeDisplayName(place),
    name: place.name,
  };
}

/**
 * Puntaje textual de un candidato para una query normalizada (0 = no matchea).
 * Mayor = más relevante. Cada token de la query debe matchear algún campo; si alguno no matchea,
 * el candidato se descarta (score 0).
 */
function textScore(entry: IndexedPlace, tokens: readonly string[]): number {
  let score = 0;
  for (const token of tokens) {
    const tokenScore = tokenScoreFor(entry, token);
    if (tokenScore === 0) return 0; // AND entre tokens: todos deben aportar.
    score += tokenScore;
  }
  // Bonus fuerte si el nombre del lugar empieza con la query completa ("jockey" → Jockey Plaza).
  const joined = tokens.join(' ');
  if (entry.name.startsWith(joined)) score += 60;
  else if (entry.name.includes(joined)) score += 15;
  return score;
}

/** Puntaje de un token individual contra un candidato. */
function tokenScoreFor(entry: IndexedPlace, token: string): number {
  if (entry.name.startsWith(token)) return 40; // prefijo del título
  if (entry.words.some((w) => w.startsWith(token))) return 25; // prefijo de alguna palabra
  if (entry.haystack.includes(token)) return 10; // substring en cualquier parte
  return 0;
}

/**
 * Factor de proximidad en [0,1]: 1 a 0 m, decae suave hasta ~0 a 25 km. No filtra: solo pondera/
 * desempata. Determinista (gran círculo). Si no hay `near`, devuelve 0 (sin sesgo).
 */
function proximityFactor(place: LimaPlace, near: LatLon | undefined): number {
  if (!near) return 0;
  const meters = distanceMeters(near, { lat: place.lat, lon: place.lon });
  const SPAN = 25_000; // 25 km cubre el área metropolitana de Lima
  return Math.max(0, 1 - meters / SPAN);
}

/** Peso del sesgo por proximidad sobre el puntaje textual (suficiente para desempatar sin dominar). */
const PROXIMITY_WEIGHT = 30;

interface Scored {
  result: GeocodeResult;
  score: number;
  /** Distancia a `near` en metros (Infinity si no hay near). Desempate final determinista. */
  distance: number;
}

/** Candidatos ordenados por relevancia (texto + proximidad), determinista. Vacío si nada matchea. */
function rank(query: string, near: LatLon | undefined): Scored[] {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Scored[] = [];
  for (const entry of INDEX) {
    const base = textScore(entry, tokens);
    if (base === 0) continue;
    const prox = proximityFactor(entry.place, near);
    const distance = near
      ? distanceMeters(near, { lat: entry.place.lat, lon: entry.place.lon })
      : Number.POSITIVE_INFINITY;
    scored.push({
      result: toGeocodeResult(entry.place),
      score: base + prox * PROXIMITY_WEIGHT,
      distance,
    });
  }

  // Orden estable y determinista: score desc, luego más cercano, luego alfabético por displayName.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.result.displayName.localeCompare(b.result.displayName);
  });
  return scored;
}

/**
 * Geocoder del dataset de Lima. Stateless: opera sobre el índice estático precomputado.
 */
export class LimaGeocoder {
  /** Mejor coincidencia textual para `query` (sesgable por `near`). `null` si nada matchea. */
  geocode(query: string, near?: LatLon): GeocodeResult | null {
    return rank(query, near)[0]?.result ?? null;
  }

  /** Top-`limit` sugerencias para `query` (sesgadas por `near`). `[]` si nada matchea. */
  autocomplete(query: string, near?: LatLon, limit = 8): GeocodeResult[] {
    return rank(query, near)
      .slice(0, limit)
      .map((s) => s.result);
  }

  /** Lugar del dataset MÁS CERCANO a `point` (siempre devuelve uno: el dataset no está vacío). */
  reverse(point: LatLon): GeocodeResult | null {
    let best: LimaPlace | null = null;
    let bestMeters = Number.POSITIVE_INFINITY;
    for (const place of LIMA_PLACES) {
      const meters = distanceMeters(point, { lat: place.lat, lon: place.lon });
      if (meters < bestMeters) {
        bestMeters = meters;
        best = place;
      }
    }
    return best ? toGeocodeResult(best) : null;
  }
}
