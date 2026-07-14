#!/usr/bin/env node
/**
 * DEV · Regenera los GPX de la demo DESDE NUESTRO SERVICIO de ruteo (el OSRM self-hosted del stack).
 *
 * Problema que resuelve (seam): los GPX dibujados a mano (gpx.studio) NO siguen el mismo camino que
 * la ruta que calcula @veo/maps (OSRM) — el simulador manejaba por una calle y el mapa/las
 * indicaciones mostraban otra: el puck se salía de la polyline y las maniobras no calzaban. Acá la
 * geometría del tramo sale del MISMO motor que pinta la ruta en ambas apps, así el sim maneja EXACTO
 * por donde la ruta dice (banner de maniobras coherente, puck siempre sobre la línea).
 *
 * Puntos de la demo (mismos endpoints de siempre — solo se regenera el CAMINO entre ellos):
 *   A = base del conductor (dentro del radio de matching)
 *   B = ubicación del pasajero (donde pide el viaje)
 *   C = destino que el pasajero busca (Av. General Salaverry, San Isidro)
 *
 * Uso:   node scripts/gen-gpx-from-service.mjs [--osrm=http://localhost:5005]
 * Luego: los tramos se manejan igual que siempre (simulate-route.mjs a-b | b-c, o el demo-director).
 *
 * OJO puerto: el compose publica OSRM en :5005 (el :5000 en macOS lo ocupa AirPlay Receiver y
 * responde 403 — parece OSRM caído y no lo es).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const routesDir = join(scriptsDir, '..', 'dev', 'routes');

const OSRM_URL =
  process.argv.find((a) => a.startsWith('--osrm='))?.slice('--osrm='.length) ??
  'http://localhost:5005';

/** Los TRES puntos de la demo (lat, lon) — NO cambiarlos sin actualizar la búsqueda del pasajero. */
const A = { lat: -12.008193, lon: -77.059937 }; // base del conductor
const B = { lat: -12.003281, lon: -77.063166 }; // ubicación del pasajero (recojo)
const C = { lat: -12.105309, lon: -77.059134 }; // destino buscado (Av. General Salaverry, San Isidro)

async function routeOf(from, to) {
  const url = `${OSRM_URL}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status} en ${url}`);
  const body = await res.json();
  if (body.code !== 'Ok' || !body.routes?.[0]) throw new Error(`OSRM sin ruta: ${body.code}`);
  const route = body.routes[0];
  // GeoJSON viene [lon, lat]; el GPX quiere lat/lon.
  const points = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  return { points, distanceMeters: Math.round(route.distance) };
}

function toGpx(name, points) {
  const trkpts = points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="veo gen-gpx-from-service (OSRM self-hosted)" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${name}</name>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

const legs = [
  { file: 'driver-a-b.gpx', name: 'driver-a-b (conductor → recojo)', from: A, to: B },
  { file: 'driver-b-c.gpx', name: 'driver-b-c (recojo → destino)', from: B, to: C },
];

for (const leg of legs) {
  const { points, distanceMeters } = await routeOf(leg.from, leg.to);
  writeFileSync(join(routesDir, leg.file), toGpx(leg.name, points));
  console.log(
    `ok · ${leg.file}: ${points.length} puntos, ${(distanceMeters / 1000).toFixed(1)} km (geometría de OSRM ${OSRM_URL})`,
  );
}
