/**
 * Estilo veo-dark ("Midnight Motion") — Mapbox Streets v8. COPIA del estilo de las apps móviles.
 *
 * ⚠️ TERCERA COPIA: este archivo es una COPIA VERBATIM del objeto `veoDarkMapboxStyle` que vive en
 *   1. `apps/passenger/src/shared/presentation/components/mapbox/veoDarkStyle.ts`
 *   2. `apps/driver/.../mapbox/veoDarkStyle.ts`
 *   3. `apps/admin-web/src/lib/map/veo-dark-style.ts` (este)
 *
 * DEUDA(dedupe · paquete neutral): el estilo ya está triplicado (passenger + driver + admin-web). El
 * candidato para unificarlo NO es `@veo/ui-kit` (ese paquete depende de React Native / `@rnmapbox/maps`
 * y admin-web es web puro). Debe promoverse a un paquete NEUTRAL nuevo (p.ej. `@veo/map-style`, JSON
 * puro sin dependencias de plataforma) que las tres apps importen; entonces se borran las tres copias.
 * No se hizo ahora para no arrastrar a passenger/driver fuera del alcance de la migración de admin-web.
 *
 * Diferencia de transporte vs. las apps móviles: en RN, `@rnmapbox/maps` resuelve `mapbox://…` con el
 * token nativo (`Mapbox.setAccessToken`). En web, **maplibre-gl 4.x dejó de soportar URLs `mapbox://`**,
 * así que el componente del mapa reescribe esas URLs a HTTPS + token vía `transformRequest`
 * (ver `apps/admin-web/src/components/map/map-view.tsx`). El objeto del estilo es IDÉNTICO.
 *
 * ── Mapeo de capas OpenMapTiles → Mapbox Streets v8 (source-layer reales del tileset) ───────────
 *  background            → background (paint, sin fuente)
 *  landcover (fill)      → landuse  (class ∈ wood/scrub/grass/park: cobertura natural)
 *  park (fill)           → landuse (class=park) + landuse_overlay (class=national_park/wetland)
 *  landuse residential   → landuse (class=residential)
 *  landuse industrial…   → landuse (class ∈ commercial_area/industrial/cemetery/hospital/school…)
 *  water (fill)          → water   (capa única, sin class)
 *  waterway (line)       → waterway (class ∈ river/canal/stream/drain/ditch)
 *  building (fill)       → building
 *  transportation …      → road (por class: minor/street/secondary/primary/motorway)
 *  boundary admin≤4      → admin (admin_level 0/1; requiere filtro worldview="all")
 *  water_name (symbol)   → natural_label (class ∈ sea/ocean/lake/water/river/bay/reservoir/…)
 *  transportation_name   → road (símbolo line-placement sobre la misma capa `road`, campo name)
 *  place suburb/town/…   → place_label (type ∈ suburb/neighbourhood/quarter/town/village)
 *  place city            → place_label (type=city)
 *  place country         → place_label (type=country; filtro worldview="all")
 */

/** Paleta veo-dark (idéntica al style.json original). Centralizada para no repetir literales. */
const palette = {
  // Negro puro = token `bg` del tema (themes.ts): el mapa y el chrome (sheets) comparten el MISMO
  // negro, sin costura visible entre mapa y superficies. Antes #0B0F14 (navy) divergía del #000000.
  bg: '#000000',
  landcover: '#10161D',
  park: '#0F1A14',
  landuseResidential: '#0E141B',
  landuseOther: '#11171F',
  water: '#0A1A2A',
  building: '#161D26',
  buildingOutline: '#1E2832',
  roadMinor: '#1B2530',
  roadStreet: '#232F3B',
  roadSecondary: '#2C3A48',
  roadPrimary: '#3A4A5A',
  roadMotorway: '#48607A',
  boundary: '#2A3340',
  labelWater: '#4A6680',
  labelWaterHalo: '#0A1A2A',
  labelStreet: '#7E8C9A',
  labelStreetHalo: '#000000',
  labelPlaceOther: '#8A98A6',
  labelPlaceCity: '#C2CED9',
  labelPlaceCityHalo: '#070A0E',
  labelCountry: '#9AA8B6',
} as const;

/** Fuente vectorial oficial de Mapbox (reemplaza la `source` OpenMapTiles del tileserver propio). */
const MAPBOX_STREETS = 'mapbox://mapbox.mapbox-streets-v8';

/** Stack de glyphs estándar disponible en cualquier cuenta Mapbox (no requiere subir fuentes). */
const FONT_REGULAR = ['DIN Pro Regular', 'Arial Unicode MS Regular'];

/** Campo de etiqueta con fallback es → estándar (Streets v8 usa `name`/`name_es`, no `name:es`). */
const NAME_FIELD: unknown = ['coalesce', ['get', 'name_es'], ['get', 'name']];

/** Filtro de mundo requerido por las capas `admin` y `place_label` (class=country) de Streets v8. */
const WORLDVIEW_ALL: unknown = ['match', ['get', 'worldview'], ['all'], true, false];

/**
 * Style JSON de Mapbox (spec v8). Tipado laxo a `Record<string, unknown>` porque el spec de estilo
 * es estructural; el componente del mapa lo castea a `StyleSpecification` de maplibre-gl al pasarlo.
 */
export const veoDarkMapboxStyle: Record<string, unknown> = {
  version: 8,
  name: 'VEO Midnight Motion (Mapbox Streets v8)',
  metadata: {
    'veo:description':
      'Estilo oscuro VEO portado a Mapbox Streets v8 (paleta idéntica al veo-dark de OpenMapTiles).',
  },
  sources: {
    composite: {
      type: 'vector',
      url: MAPBOX_STREETS,
    },
  },
  // glyphs/sprite los resuelve Mapbox desde la cuenta del token público (mapbox://fonts, mapbox://sprites).
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': palette.bg },
    },
    // landcover (OMT) → cobertura natural en `landuse` de Streets v8.
    {
      id: 'landcover',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['wood', 'scrub', 'grass', 'glacier'], true, false],
      paint: {
        'fill-color': palette.landcover,
        'fill-opacity': 0.6,
      },
    },
    // park (OMT) → landuse class=park + landuse_overlay (national_park/wetland).
    {
      id: 'park',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'park'],
      paint: {
        'fill-color': palette.park,
        'fill-opacity': 0.5,
      },
    },
    {
      id: 'park-overlay',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse_overlay',
      filter: [
        'match',
        ['get', 'class'],
        ['national_park', 'wetland', 'wetland_noveg'],
        true,
        false,
      ],
      paint: {
        'fill-color': palette.park,
        'fill-opacity': 0.5,
      },
    },
    {
      id: 'landuse-residential',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'residential'],
      paint: {
        'fill-color': palette.landuseResidential,
        'fill-opacity': 0.5,
      },
    },
    {
      id: 'landuse-other',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: [
        'match',
        ['get', 'class'],
        ['industrial', 'commercial_area', 'cemetery', 'hospital', 'school', 'parking', 'airport'],
        true,
        false,
      ],
      paint: {
        'fill-color': palette.landuseOther,
        'fill-opacity': 0.4,
      },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'composite',
      'source-layer': 'water',
      paint: {
        'fill-color': palette.water,
      },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'composite',
      'source-layer': 'waterway',
      minzoom: 8,
      paint: {
        'line-color': palette.water,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.8],
      },
    },
    {
      id: 'building',
      type: 'fill',
      source: 'composite',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-color': palette.building,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.7],
        'fill-outline-color': palette.buildingOutline,
      },
    },
    {
      id: 'transportation-minor',
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      minzoom: 12,
      filter: ['match', ['get', 'class'], ['service', 'track', 'path', 'pedestrian'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.roadMinor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 3],
      },
    },
    {
      id: 'transportation-street',
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      minzoom: 11,
      filter: [
        'match',
        ['get', 'class'],
        ['tertiary', 'tertiary_link', 'street', 'street_limited'],
        true,
        false,
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.roadStreet,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 5],
      },
    },
    {
      id: 'transportation-secondary',
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      minzoom: 9,
      filter: ['match', ['get', 'class'], ['secondary', 'secondary_link'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.roadSecondary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 16, 6],
      },
    },
    {
      id: 'transportation-primary',
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      minzoom: 7,
      filter: [
        'match',
        ['get', 'class'],
        ['primary', 'primary_link', 'trunk', 'trunk_link'],
        true,
        false,
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.roadPrimary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 16, 8],
      },
    },
    {
      id: 'transportation-motorway',
      type: 'line',
      source: 'composite',
      'source-layer': 'road',
      minzoom: 5,
      filter: ['match', ['get', 'class'], ['motorway', 'motorway_link'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.roadMotorway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 16, 10],
      },
    },
    {
      id: 'boundary-admin',
      type: 'line',
      source: 'composite',
      'source-layer': 'admin',
      filter: [
        'all',
        ['<=', ['get', 'admin_level'], 1],
        ['==', ['get', 'maritime'], 'false'],
        WORLDVIEW_ALL,
      ],
      paint: {
        'line-color': palette.boundary,
        'line-dasharray': [2, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 10, 1.2],
      },
    },
    {
      id: 'label-water',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'natural_label',
      minzoom: 8,
      filter: [
        'match',
        ['get', 'class'],
        ['sea', 'ocean', 'lake', 'water', 'river', 'bay', 'reservoir', 'canal', 'stream'],
        true,
        false,
      ],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-letter-spacing': 0.1,
        'symbol-placement': 'point',
      },
      paint: {
        'text-color': palette.labelWater,
        'text-halo-color': palette.labelWaterHalo,
        'text-halo-width': 1,
      },
    },
    {
      id: 'label-street',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'road',
      // Calles sólo al acercarse (≥15), con fade.
      minzoom: 15,
      filter: ['has', 'name'],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 18, 13],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
      },
      paint: {
        'text-color': palette.labelStreet,
        'text-halo-color': palette.labelStreetHalo,
        'text-halo-width': 1.2,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.85],
      },
    },
    {
      id: 'label-place-other',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'place_label',
      // DECLUTTER: barrios sutiles sólo al hacer zoom (≥13).
      minzoom: 13,
      maxzoom: 17,
      filter: [
        'match',
        ['get', 'type'],
        ['suburb', 'neighbourhood', 'quarter', 'town', 'village', 'hamlet'],
        true,
        false,
      ],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12],
        'text-max-width': 8,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': palette.labelPlaceOther,
        'text-halo-color': palette.labelStreetHalo,
        'text-halo-width': 1.4,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.5, 17, 0.65],
      },
    },
    {
      id: 'label-place-city',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'place_label',
      minzoom: 4,
      maxzoom: 14,
      filter: ['==', ['get', 'type'], 'city'],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 12, 20],
        'text-max-width': 8,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': palette.labelPlaceCity,
        'text-halo-color': palette.labelPlaceCityHalo,
        'text-halo-width': 1.6,
      },
    },
    {
      id: 'label-country',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'place_label',
      minzoom: 2,
      maxzoom: 8,
      filter: ['all', ['==', ['get', 'type'], 'country'], WORLDVIEW_ALL],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 18],
        'text-max-width': 8,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.15,
      },
      paint: {
        'text-color': palette.labelCountry,
        'text-halo-color': palette.labelPlaceCityHalo,
        'text-halo-width': 1.6,
      },
    },
  ],
};
