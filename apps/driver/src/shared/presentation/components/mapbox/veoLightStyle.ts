/**
 * Estilo veo-light ("Daylight Trust") sobre **Mapbox Streets v8**.
 *
 * Migración dark→light Trust (Theme de Confianza): el mapa del pasajero adopta la MISMA paleta clara
 * que ya usa el admin-web (`apps/admin-web/src/lib/map/veo-map-style.ts`, `lightPalette`). La estructura
 * de capas (filtros, minzooms, anchos de línea, símbolos) es IDÉNTICA a la variante oscura anterior
 * (`veoDarkStyle.ts`, eliminado): solo cambian las constantes de color de la `palette`. El lienzo del
 * mapa (`bg #F5F7FA`) matchea el token `bg` del tema (themes.ts), así que mapa y chrome (sheets)
 * comparten el MISMO canvas sin costura visible.
 *
 * El objeto Style JSON se pasa a `MapView` vía `styleJSON` (string). El token público de Mapbox lo
 * resuelve `Mapbox.setAccessToken` en el bootstrap nativo, así que las fuentes/glyphs usan las URLs
 * `mapbox://…` (sin token embebido).
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
 *  transportation minor… → road (class ∈ service/track/path)
 *  transportation street → road (class ∈ tertiary/street/street_limited)
 *  transportation second → road (class=secondary)
 *  transportation prim…  → road (class ∈ primary/trunk)
 *  transportation motor  → road (class=motorway)
 *  boundary admin≤4      → admin (admin_level 0/1; requiere filtro worldview="all")
 *  water_name (symbol)   → natural_label (class ∈ sea/ocean/lake/water/river/bay/reservoir/…)
 *  transportation_name   → road (símbolo line-placement sobre la misma capa `road`, campo name)
 *  place suburb/town/…   → place_label (type ∈ suburb/neighbourhood/quarter/town/village)
 *  place city            → place_label (type=city)
 *  place country         → place_label (type=country; filtro worldview="all")
 */

/** Paleta veo-light "Daylight Trust" (idéntica al `lightPalette` del admin-web). */
const palette = {
  // Canvas claro = token `bg` del tema (themes.ts #F5F7FA): mapa y sheets comparten el mismo lienzo.
  bg: '#F5F7FA',
  landcover: '#E9F3EC',
  park: '#E2F3E9',
  landuseResidential: '#F0F3F7',
  landuseOther: '#EDF1F5',
  water: '#D4E6F2',
  building: '#E6EBF1',
  buildingOutline: '#DCE3EB',
  roadMinor: '#E6EBF1',
  roadStreet: '#DCE3EB',
  roadSecondary: '#CBD3DD',
  roadPrimary: '#BAC4CF',
  roadMotorway: '#A7B3C1',
  boundary: '#C5CDD6',
  labelWater: '#7E9BB5',
  labelWaterHalo: '#FFFFFF',
  labelStreet: '#8A929E',
  labelStreetHalo: '#FFFFFF',
  labelPlaceOther: '#6B7A8F',
  labelPlaceCity: '#1A2332',
  labelPlaceCityHalo: '#FFFFFF',
  labelCountry: '#6B7A8F',
} as const;

/** Fuente vectorial oficial de Mapbox (reemplaza la `source` OpenMapTiles del tileserver propio). */
const MAPBOX_STREETS = 'mapbox://mapbox.mapbox-streets-v8';

/* ── Edificios 3D (fill-extrusion) — parámetros de gusto ─────────────────────────────────────────
 * En @rnmapbox 10.3.1 no existe Mapbox Standard (v11), pero fill-extrusion sí: con el NAV_PITCH de
 * la cámara de navegación la ciudad gana volumen. GATE de performance: `minzoom 15` — en el overview
 * del dashboard (z12) la capa ni se evalúa; solo pesa cerca de calle (nav z17), donde el tile ya está
 * cargado. Si en hardware de flota pesara, subir el minzoom antes que tocar la opacidad. */
/** Zoom mínimo de la extrusión (gate de performance: por debajo no se renderiza nada). */
const BUILDING_3D_MINZOOM = 15;
/** Opacidad de la extrusión: sutil, los edificios acompañan sin competir con la ruta. */
const BUILDING_3D_OPACITY = 0.6;

/** Stack de glyphs estándar disponible en cualquier cuenta Mapbox (no requiere subir fuentes). */
const FONT_REGULAR = ['DIN Pro Regular', 'Arial Unicode MS Regular'];

/** Campo de etiqueta con fallback es → estándar (Streets v8 usa `name`/`name_es`, no `name:es`). */
const NAME_FIELD: unknown = ['coalesce', ['get', 'name_es'], ['get', 'name']];

/** Filtro de mundo requerido por las capas `admin` y `place_label` (class=country) de Streets v8. */
const WORLDVIEW_ALL: unknown = [
  'match',
  ['get', 'worldview'],
  ['all'],
  true,
  false,
];

/**
 * Style JSON de Mapbox (spec v8). Tipado laxo a `Record<string, unknown>` porque el spec de estilo
 * es estructural y `@rnmapbox/maps` lo recibe como string vía `styleJSON`; no aporta tipos del spec.
 */
export const veoLightMapboxStyle: Record<string, unknown> = {
  version: 8,
  name: 'VEO Daylight Trust (Mapbox Streets v8)',
  metadata: {
    'veo:description':
      'Estilo claro VEO "Daylight Trust" sobre Mapbox Streets v8 (paleta idéntica al admin-web).',
  },
  sources: {
    composite: {
      type: 'vector',
      url: MAPBOX_STREETS,
    },
  },
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {'background-color': palette.bg},
    },
    {
      id: 'landcover',
      type: 'fill',
      source: 'composite',
      'source-layer': 'landuse',
      filter: [
        'match',
        ['get', 'class'],
        ['wood', 'scrub', 'grass', 'glacier'],
        true,
        false,
      ],
      paint: {
        'fill-color': palette.landcover,
        'fill-opacity': 0.6,
      },
    },
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
        [
          'industrial',
          'commercial_area',
          'cemetery',
          'hospital',
          'school',
          'parking',
          'airport',
        ],
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
      filter: [
        'match',
        ['get', 'class'],
        ['service', 'track', 'path', 'pedestrian'],
        true,
        false,
      ],
      layout: {'line-cap': 'round', 'line-join': 'round'},
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
      layout: {'line-cap': 'round', 'line-join': 'round'},
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
      filter: [
        'match',
        ['get', 'class'],
        ['secondary', 'secondary_link'],
        true,
        false,
      ],
      layout: {'line-cap': 'round', 'line-join': 'round'},
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
      layout: {'line-cap': 'round', 'line-join': 'round'},
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
      filter: [
        'match',
        ['get', 'class'],
        ['motorway', 'motorway_link'],
        true,
        false,
      ],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {
        'line-color': palette.roadMotorway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 16, 10],
      },
    },
    {
      // Edificios 3D sutiles: color derivado de la paleta Trust (base `building`, coronando hacia
      // `buildingOutline` en los más altos para que el volumen lea sin sombras duras). Va DESPUÉS de
      // las capas de ruta viales (a pitch la extrusión debe verse "parada" sobre ellas) y ANTES de
      // los símbolos (las etiquetas siempre legibles encima). La transición minzoom→+1 hace crecer
      // la altura desde 0 (aparición suave, sin pop). `underground=false`: no extruir sótanos.
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'composite',
      'source-layer': 'building',
      minzoom: BUILDING_3D_MINZOOM,
      filter: [
        'all',
        ['==', ['get', 'extrude'], 'true'],
        ['==', ['get', 'underground'], 'false'],
      ],
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['get', 'height'],
          0,
          palette.building,
          60,
          palette.buildingOutline,
        ],
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          BUILDING_3D_MINZOOM,
          0,
          BUILDING_3D_MINZOOM + 1,
          ['get', 'height'],
        ],
        'fill-extrusion-base': [
          'interpolate',
          ['linear'],
          ['zoom'],
          BUILDING_3D_MINZOOM,
          0,
          BUILDING_3D_MINZOOM + 1,
          ['get', 'min_height'],
        ],
        'fill-extrusion-opacity': BUILDING_3D_OPACITY,
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
        [
          'sea',
          'ocean',
          'lake',
          'water',
          'river',
          'bay',
          'reservoir',
          'canal',
          'stream',
        ],
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
      // Calles sólo al acercarse a buscar el pickup (≥15), con fade. A z12 (Home) ya estaban ocultas.
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
      // DECLUTTER (premium): los barrios NO se muestran en el overview de Home (z=LIMA_ZOOM=12);
      // aparecen sutiles sólo al hacer zoom para orientarse (≥13). Antes minzoom 8 → gritaban a z12.
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
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13,
          0,
          14,
          0.5,
          17,
          0.65,
        ],
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

/**
 * Style serializado para el prop `styleJSON` de `MapView`. Se memoiza a nivel de módulo (el objeto
 * es constante) para no re-stringificar en cada render del mapa.
 */
export const veoLightMapboxStyleJSON: string =
  JSON.stringify(veoLightMapboxStyle);
