/**
 * Dataset curado de lugares reales de Lima Metropolitana (soberano, determinista, sin APIs externas).
 *
 * Lo usa `LocalMapsEngine` (dev/CI, `VEO_MAPS_MODE=local`) para geocoding/autocomplete/reverse cuando
 * OSRM/Nominatim aún no tienen cargado el extracto OSM de Perú. NO es un mock: son coordenadas reales
 * aproximadas (centro del predio/manzana) y permiten que la búsqueda, el autocompletado y la pastilla
 * "Tu ubicación" devuelvan resultados creíbles en desarrollo.
 *
 * Convención de campos (alineada con `GeocodeResult` y el `splitLabel` del public-bff):
 *  - `name`     → título de la sugerencia (PlaceSuggestion.title).
 *  - `district` → distrito; se usa para el subtítulo y para el `displayName`.
 *  - `displayName` se deriva como `"{name}, {district}, Lima"` → subtítulo limpio "{district}, Lima".
 *
 * Coordenadas en grados decimales WGS84 (lat negativo = sur, lon negativo = oeste).
 */

/** Categoría del lugar (orienta el match y futuros íconos en la app). */
export type LimaPlaceKind =
  | 'mall'
  | 'airport'
  | 'park'
  | 'district'
  | 'university'
  | 'hospital'
  | 'plaza'
  | 'avenue'
  | 'landmark'
  | 'transport';

/** Un lugar curado del dataset de Lima. */
export interface LimaPlace {
  /** Nombre corto del lugar (se mapea a `GeocodeResult.name` → título de la sugerencia). */
  name: string;
  /** Distrito al que pertenece (parte del subtítulo). */
  district: string;
  /** Categoría del lugar. */
  kind: LimaPlaceKind;
  lat: number;
  lon: number;
  /** Alias/variantes de búsqueda (siglas, nombres alternos) además de `name`+`district`. */
  aliases?: readonly string[];
}

/**
 * ~75 lugares reales de Lima. Coordenadas aproximadas (centro del predio). Ordenados por categoría
 * para legibilidad; el orden NO afecta la búsqueda (siempre se ordena por relevancia/proximidad).
 */
export const LIMA_PLACES: readonly LimaPlace[] = [
  // ─── Centros comerciales (malls) ───────────────────────────────────────────
  { name: 'Jockey Plaza', district: 'Santiago de Surco', kind: 'mall', lat: -12.0853, lon: -76.9781, aliases: ['jockey'] },
  { name: 'Larcomar', district: 'Miraflores', kind: 'mall', lat: -12.1318, lon: -77.0306, aliases: ['centro comercial larcomar'] },
  { name: 'Plaza San Miguel', district: 'San Miguel', kind: 'mall', lat: -12.0772, lon: -77.0823 },
  { name: 'Real Plaza Salaverry', district: 'Jesús María', kind: 'mall', lat: -12.0905, lon: -77.0524, aliases: ['real plaza'] },
  { name: 'Real Plaza Centro Cívico', district: 'Cercado de Lima', kind: 'mall', lat: -12.0578, lon: -77.0353 },
  { name: 'Mall del Sur', district: 'San Juan de Miraflores', kind: 'mall', lat: -12.1607, lon: -76.9846 },
  { name: 'MegaPlaza', district: 'Independencia', kind: 'mall', lat: -11.9899, lon: -77.0606, aliases: ['mega plaza norte'] },
  { name: 'Plaza Norte', district: 'Independencia', kind: 'mall', lat: -11.9931, lon: -77.0589 },
  { name: 'Open Plaza Angamos', district: 'Surquillo', kind: 'mall', lat: -12.1108, lon: -77.0145 },
  { name: 'Centro Comercial Caminos del Inca', district: 'Santiago de Surco', kind: 'mall', lat: -12.1147, lon: -76.9899 },
  { name: 'Mall Aventura Santa Anita', district: 'Santa Anita', kind: 'mall', lat: -12.0468, lon: -76.9716 },

  // ─── Aeropuerto y transporte ─────────────────────────────────────────────────
  { name: 'Aeropuerto Internacional Jorge Chávez', district: 'Callao', kind: 'airport', lat: -12.0219, lon: -77.1143, aliases: ['aeropuerto', 'jorge chavez', 'lim', 'aeropuerto de lima'] },
  { name: 'Terminal Terrestre Plaza Norte', district: 'Independencia', kind: 'transport', lat: -11.9926, lon: -77.0598, aliases: ['terrapuerto plaza norte'] },
  { name: 'Estación Central Metropolitano', district: 'Cercado de Lima', kind: 'transport', lat: -12.0606, lon: -77.0369, aliases: ['metropolitano'] },
  { name: 'Estación Gamarra', district: 'La Victoria', kind: 'transport', lat: -12.0681, lon: -77.0118, aliases: ['gamarra'] },

  // ─── Parques ─────────────────────────────────────────────────────────────────
  { name: 'Parque Kennedy', district: 'Miraflores', kind: 'park', lat: -12.1211, lon: -77.0297, aliases: ['parque central miraflores'] },
  { name: 'El Olivar', district: 'San Isidro', kind: 'park', lat: -12.0975, lon: -77.0386, aliases: ['bosque el olivar', 'parque el olivar'] },
  { name: 'Parque de la Reserva', district: 'Cercado de Lima', kind: 'park', lat: -12.0699, lon: -77.0339, aliases: ['circuito magico del agua'] },
  { name: 'Parque de las Aguas', district: 'Cercado de Lima', kind: 'park', lat: -12.0701, lon: -77.0335 },
  { name: 'Parque del Amor', district: 'Miraflores', kind: 'park', lat: -12.1305, lon: -77.0322 },
  { name: 'Pantanos de Villa', district: 'Chorrillos', kind: 'park', lat: -12.2089, lon: -76.9889 },
  { name: 'Parque de la Exposición', district: 'Cercado de Lima', kind: 'park', lat: -12.0658, lon: -77.0364 },
  { name: 'Parque Zonal Huiracocha', district: 'San Juan de Lurigancho', kind: 'park', lat: -12.0093, lon: -77.0009 },

  // ─── Distritos (centroides aproximados) ───────────────────────────────────────
  { name: 'Miraflores', district: 'Miraflores', kind: 'district', lat: -12.1219, lon: -77.0298 },
  { name: 'San Isidro', district: 'San Isidro', kind: 'district', lat: -12.0975, lon: -77.0365 },
  { name: 'Santiago de Surco', district: 'Santiago de Surco', kind: 'district', lat: -12.1453, lon: -76.9947, aliases: ['surco'] },
  { name: 'Barranco', district: 'Barranco', kind: 'district', lat: -12.1490, lon: -77.0210 },
  { name: 'San Borja', district: 'San Borja', kind: 'district', lat: -12.1057, lon: -76.9994 },
  { name: 'La Molina', district: 'La Molina', kind: 'district', lat: -12.0769, lon: -76.9447 },
  { name: 'Callao', district: 'Callao', kind: 'district', lat: -12.0566, lon: -77.1181 },
  { name: 'San Miguel', district: 'San Miguel', kind: 'district', lat: -12.0772, lon: -77.0922 },
  { name: 'Jesús María', district: 'Jesús María', kind: 'district', lat: -12.0739, lon: -77.0494 },
  { name: 'Pueblo Libre', district: 'Pueblo Libre', kind: 'district', lat: -12.0743, lon: -77.0631 },
  { name: 'Magdalena del Mar', district: 'Magdalena del Mar', kind: 'district', lat: -12.0908, lon: -77.0720 },
  { name: 'Lince', district: 'Lince', kind: 'district', lat: -12.0852, lon: -77.0364 },
  { name: 'Surquillo', district: 'Surquillo', kind: 'district', lat: -12.1126, lon: -77.0153 },
  { name: 'Chorrillos', district: 'Chorrillos', kind: 'district', lat: -12.1714, lon: -77.0259 },
  { name: 'San Juan de Lurigancho', district: 'San Juan de Lurigancho', kind: 'district', lat: -11.9939, lon: -77.0064, aliases: ['sjl'] },
  { name: 'Los Olivos', district: 'Los Olivos', kind: 'district', lat: -11.9706, lon: -77.0700 },
  { name: 'Ate', district: 'Ate', kind: 'district', lat: -12.0258, lon: -76.9181 },
  { name: 'Cercado de Lima', district: 'Cercado de Lima', kind: 'district', lat: -12.0464, lon: -77.0428, aliases: ['centro de lima', 'lima centro'] },

  // ─── Universidades ─────────────────────────────────────────────────────────────
  { name: 'Pontificia Universidad Católica del Perú', district: 'San Miguel', kind: 'university', lat: -12.0686, lon: -77.0779, aliases: ['pucp', 'catolica'] },
  { name: 'Universidad Nacional Mayor de San Marcos', district: 'Cercado de Lima', kind: 'university', lat: -12.0570, lon: -77.0830, aliases: ['unmsm', 'san marcos', 'ciudad universitaria'] },
  { name: 'Universidad de Lima', district: 'Santiago de Surco', kind: 'university', lat: -12.0852, lon: -76.9707, aliases: ['ulima', 'u de lima'] },
  { name: 'Universidad del Pacífico', district: 'Jesús María', kind: 'university', lat: -12.0826, lon: -77.0506, aliases: ['up'] },
  { name: 'Universidad Nacional de Ingeniería', district: 'Rímac', kind: 'university', lat: -12.0233, lon: -77.0496, aliases: ['uni'] },
  { name: 'Universidad Peruana Cayetano Heredia', district: 'San Martín de Porres', kind: 'university', lat: -12.0228, lon: -77.0608, aliases: ['upch', 'cayetano heredia'] },
  { name: 'Universidad ESAN', district: 'Santiago de Surco', kind: 'university', lat: -12.1059, lon: -76.9745, aliases: ['esan'] },
  { name: 'Universidad San Ignacio de Loyola', district: 'La Molina', kind: 'university', lat: -12.0903, lon: -76.9697, aliases: ['usil'] },

  // ─── Hospitales / clínicas grandes ─────────────────────────────────────────────
  { name: 'Hospital Nacional Edgardo Rebagliati', district: 'Jesús María', kind: 'hospital', lat: -12.0810, lon: -77.0432, aliases: ['rebagliati'] },
  { name: 'Hospital Nacional Dos de Mayo', district: 'Cercado de Lima', kind: 'hospital', lat: -12.0556, lon: -77.0177 },
  { name: 'Hospital Guillermo Almenara', district: 'La Victoria', kind: 'hospital', lat: -12.0556, lon: -77.0186, aliases: ['almenara'] },
  { name: 'Clínica Internacional San Borja', district: 'San Borja', kind: 'hospital', lat: -12.1006, lon: -77.0007 },
  { name: 'Clínica Ricardo Palma', district: 'San Isidro', kind: 'hospital', lat: -12.0950, lon: -77.0246 },
  { name: 'Clínica Anglo Americana', district: 'San Isidro', kind: 'hospital', lat: -12.1027, lon: -77.0421 },
  { name: 'Hospital de Emergencias Grau', district: 'La Victoria', kind: 'hospital', lat: -12.0625, lon: -77.0258 },

  // ─── Plazas y landmarks ──────────────────────────────────────────────────────
  { name: 'Plaza Mayor de Lima', district: 'Cercado de Lima', kind: 'plaza', lat: -12.0464, lon: -77.0306, aliases: ['plaza de armas', 'plaza mayor'] },
  { name: 'Plaza San Martín', district: 'Cercado de Lima', kind: 'plaza', lat: -12.0531, lon: -77.0345 },
  { name: 'Plaza Bolognesi', district: 'Cercado de Lima', kind: 'plaza', lat: -12.0617, lon: -77.0413 },
  { name: 'Óvalo Gutiérrez', district: 'Miraflores', kind: 'plaza', lat: -12.1102, lon: -77.0334, aliases: ['ovalo gutierrez'] },
  { name: 'Óvalo de Miraflores', district: 'Miraflores', kind: 'plaza', lat: -12.1196, lon: -77.0289, aliases: ['ovalo miraflores'] },
  { name: 'Catedral de Lima', district: 'Cercado de Lima', kind: 'landmark', lat: -12.0463, lon: -77.0298 },
  { name: 'Estadio Nacional', district: 'Cercado de Lima', kind: 'landmark', lat: -12.0672, lon: -77.0335 },
  { name: 'Estadio Monumental', district: 'Ate', kind: 'landmark', lat: -12.0436, lon: -76.9419, aliases: ['monumental'] },
  { name: 'Costa Verde', district: 'Miraflores', kind: 'landmark', lat: -12.1289, lon: -77.0353 },
  { name: 'Huaca Pucllana', district: 'Miraflores', kind: 'landmark', lat: -12.1108, lon: -77.0349 },
  { name: 'Mercado Central de Lima', district: 'Cercado de Lima', kind: 'landmark', lat: -12.0506, lon: -77.0263 },

  // ─── Avenidas principales (punto representativo) ───────────────────────────────
  { name: 'Avenida Javier Prado', district: 'San Isidro', kind: 'avenue', lat: -12.0921, lon: -77.0233, aliases: ['javier prado'] },
  { name: 'Avenida Arequipa', district: 'Lince', kind: 'avenue', lat: -12.0890, lon: -77.0345, aliases: ['arequipa'] },
  { name: 'Avenida La Marina', district: 'San Miguel', kind: 'avenue', lat: -12.0779, lon: -77.0876, aliases: ['la marina'] },
  { name: 'Avenida Brasil', district: 'Pueblo Libre', kind: 'avenue', lat: -12.0772, lon: -77.0593, aliases: ['brasil'] },
  { name: 'Avenida Benavides', district: 'Miraflores', kind: 'avenue', lat: -12.1240, lon: -77.0150, aliases: ['benavides'] },
  { name: 'Avenida Larco', district: 'Miraflores', kind: 'avenue', lat: -12.1257, lon: -77.0297, aliases: ['larco'] },
  { name: 'Avenida Salaverry', district: 'Jesús María', kind: 'avenue', lat: -12.0894, lon: -77.0498, aliases: ['salaverry'] },
  { name: 'Avenida Angamos', district: 'Surquillo', kind: 'avenue', lat: -12.1107, lon: -77.0190, aliases: ['angamos'] },
  { name: 'Avenida Universitaria', district: 'San Miguel', kind: 'avenue', lat: -12.0700, lon: -77.0820, aliases: ['universitaria'] },
  { name: 'Avenida Abancay', district: 'Cercado de Lima', kind: 'avenue', lat: -12.0530, lon: -77.0250, aliases: ['abancay'] },
];

/** Dirección legible derivada de un lugar: `"{name}, {district}, Lima"`. */
export function placeDisplayName(place: LimaPlace): string {
  return `${place.name}, ${place.district}, Lima`;
}
