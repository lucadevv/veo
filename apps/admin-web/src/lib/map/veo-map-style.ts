/**
 * Estilos VEO para Mapbox Streets v8 (spec v8) — factory con paleta intercambiable. Reemplaza al
 * antiguo `veo-dark-style.ts` (que era una copia con la paleta oscura inline). Mismas capas OpenMapTiles
 * → Streets v8; SOLO cambia la paleta:
 *   - `veoDarkMapboxStyle`  — "Midnight Motion" (lienzo negro de las apps móviles)
 *   - `veoLightMapboxStyle` — "Daylight Trust" (lienzo claro del panel admin, paleta trust del veo.pen)
 *
 * maplibre-gl 4.x dropeó `mapbox://`; el componente del mapa reescribe tileset + glyphs a HTTPS + token
 * vía `transformRequest` (ver `map-view.tsx`). El objeto del estilo es un Style spec v8 válido.
 */

interface Palette {
  bg: string;
  landcover: string;
  park: string;
  landuseResidential: string;
  landuseOther: string;
  water: string;
  building: string;
  buildingOutline: string;
  roadMinor: string;
  roadStreet: string;
  roadSecondary: string;
  roadPrimary: string;
  roadMotorway: string;
  boundary: string;
  labelWater: string;
  labelWaterHalo: string;
  labelStreet: string;
  labelStreetHalo: string;
  labelPlaceOther: string;
  labelPlaceCity: string;
  labelPlaceCityHalo: string;
  labelCountry: string;
}

/** Paleta oscura "Midnight Motion" (idéntica al veo-dark original de las apps móviles). */
const darkPalette: Palette = {
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
};

/** Paleta clara "Daylight Trust" — lienzo #F5F7FA, calles/gris del veo.pen (streets #CBD3DD), texto slate. */
const lightPalette: Palette = {
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
};

const MAPBOX_STREETS = 'mapbox://mapbox.mapbox-streets-v8';
const FONT_REGULAR = ['DIN Pro Regular', 'Arial Unicode MS Regular'];
const NAME_FIELD: unknown = ['coalesce', ['get', 'name_es'], ['get', 'name']];
const WORLDVIEW_ALL: unknown = ['match', ['get', 'worldview'], ['all'], true, false];

/** Construye el Style JSON (spec v8) con la paleta dada. Tipado laxo: el spec es estructural. */
function buildVeoMapboxStyle(p: Palette, name: string): Record<string, unknown> {
  return {
    version: 8,
    name,
    sources: { composite: { type: 'vector', url: MAPBOX_STREETS } },
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.bg } },
      {
        id: 'landcover',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['match', ['get', 'class'], ['wood', 'scrub', 'grass', 'glacier'], true, false],
        paint: { 'fill-color': p.landcover, 'fill-opacity': 0.6 },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['==', ['get', 'class'], 'park'],
        paint: { 'fill-color': p.park, 'fill-opacity': 0.5 },
      },
      {
        id: 'park-overlay',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse_overlay',
        filter: ['match', ['get', 'class'], ['national_park', 'wetland', 'wetland_noveg'], true, false],
        paint: { 'fill-color': p.park, 'fill-opacity': 0.5 },
      },
      {
        id: 'landuse-residential',
        type: 'fill',
        source: 'composite',
        'source-layer': 'landuse',
        filter: ['==', ['get', 'class'], 'residential'],
        paint: { 'fill-color': p.landuseResidential, 'fill-opacity': 0.5 },
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
        paint: { 'fill-color': p.landuseOther, 'fill-opacity': 0.4 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'composite',
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'composite',
        'source-layer': 'waterway',
        minzoom: 8,
        paint: {
          'line-color': p.water,
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
          'fill-color': p.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.7],
          'fill-outline-color': p.buildingOutline,
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
          'line-color': p.roadMinor,
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
          'line-color': p.roadStreet,
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
          'line-color': p.roadSecondary,
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
          'line-color': p.roadPrimary,
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
          'line-color': p.roadMotorway,
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
          'line-color': p.boundary,
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
          'text-color': p.labelWater,
          'text-halo-color': p.labelWaterHalo,
          'text-halo-width': 1,
        },
      },
      {
        id: 'label-street',
        type: 'symbol',
        source: 'composite',
        'source-layer': 'road',
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
          'text-color': p.labelStreet,
          'text-halo-color': p.labelStreetHalo,
          'text-halo-width': 1.2,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.85],
        },
      },
      {
        id: 'label-place-other',
        type: 'symbol',
        source: 'composite',
        'source-layer': 'place_label',
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
          'text-color': p.labelPlaceOther,
          'text-halo-color': p.labelStreetHalo,
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
          'text-color': p.labelPlaceCity,
          'text-halo-color': p.labelPlaceCityHalo,
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
          'text-color': p.labelCountry,
          'text-halo-color': p.labelPlaceCityHalo,
          'text-halo-width': 1.6,
        },
      },
    ],
  };
}

export const veoDarkMapboxStyle = buildVeoMapboxStyle(darkPalette, 'VEO Midnight Motion');
export const veoLightMapboxStyle = buildVeoMapboxStyle(lightPalette, 'VEO Daylight Trust');
