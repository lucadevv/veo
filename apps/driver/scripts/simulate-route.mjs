#!/usr/bin/env node
/**
 * DEV · Carga una ruta GPX en el GPS del SIMULADOR (como un device moviéndose de verdad).
 *
 * El módulo nativo de background-geolocation SÍ emite en el simulador cuando el sim tiene ubicación
 * simulada en movimiento (verificado en vivo): el DevFallbackLocationSource detecta las muestras
 * nativas y CORTA el stub → la app consume el GPS del simulador por el MISMO camino que en un device
 * real (publisher → Kafka → hot index → pin del pasajero → banner de maniobra → re-ruteo).
 *
 * Flujo de la demo (dos tramos, mismos puntos que el viaje real):
 *   1. ANTES de pedir el viaje:      node scripts/simulate-route.mjs a-b     ← conductor va al RECOJO
 *   2. Al tocar "Iniciar viaje":     node scripts/simulate-route.mjs b-c     ← pasajero a bordo, a destino
 *   3. Para frenar la simulación:    node scripts/simulate-route.mjs stop
 *
 * Las rutas viven en dev/routes/driver-<tramo>.gpx (dibujadas en https://gpx.studio sobre calles
 * reales). DOS reglas de costura para que la demo haga match con el viaje REAL:
 *   1. El último punto de a-b == primer punto de b-c (el recojo B), y ese punto debe caer cerca de
 *      la ubicación del pasajero del sim para que el matcher encuentre al conductor.
 *   2. El último punto de b-c (el destino C) debe ser un lugar BUSCABLE en el autocomplete y el que
 *      efectivamente se elige en la demo — si el pasajero busca otro destino, la ruta que traza el
 *      server no coincide con la que "maneja" el sim. Hoy b-c termina en Av. General Salaverry (San
 *      Isidro): buscá "Avenida General Salaverry" — o redibujá b-c hasta tu destino de demo (p. ej.
 *      Larcomar, Malecón de la Reserva, Miraflores) y buscá ESE. Ojo: existe un "Jirón Larcomar" en
 *      Ventanilla que confunde al autocomplete — elegí la sugerencia de MIRAFLORES.
 *
 * Uso: node scripts/simulate-route.mjs <a-b|b-c|stop> [--speed=10] [--device="iPhone 17 Pro Max"]
 *   --speed   m/s del recorrido (default 10 ≈ 36 km/h urbano)
 *   --device  nombre del simulador BOOTEADO que corre la app conductor (default "iPhone 17 Pro Max")
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [, , leg, ...rest] = process.argv;
const speed = Number((rest.find((a) => a.startsWith('--speed=')) ?? '--speed=10').split('=')[1]);
const deviceName = (rest.find((a) => a.startsWith('--device=')) ?? '--device=iPhone 17 Pro Max')
  .split('=')[1];

if (!leg || !['a-b', 'b-c', 'stop', 'base'].includes(leg)) {
  console.error(
    'uso: node scripts/simulate-route.mjs <a-b|b-c|base|stop> [--speed=10] [--device="..."]',
  );
  process.exit(1);
}

/** UDID del simulador BOOTEADO cuyo nombre matchea --device. */
function bootedUdid() {
  const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.includes(deviceName) && l.includes('(Booted)'));
  const udid = line?.match(/\(([0-9A-F-]{36})\)/)?.[1];
  if (!udid) {
    console.error(`no hay un simulador BOOTEADO llamado "${deviceName}". Bootealo o pasá --device=`);
    process.exit(1);
  }
  return udid;
}

const udid = bootedUdid();

if (leg === 'stop') {
  execFileSync('xcrun', ['simctl', 'location', udid, 'clear']);
  console.log(`ok · simulación de ubicación detenida en ${deviceName}`);
  process.exit(0);
}

if (leg === 'base') {
  // Vuelta a la BASE A (inicio de a-b): deja al conductor dentro del radio del matcher, listo para
  // el próximo pedido de la demo (tras completar en C quedaba a km del recojo → "sin candidatos").
  const gpxAB = join(root, 'dev/routes', 'driver-a-b.gpx');
  const first = readFileSync(gpxAB, 'utf8').match(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/);
  if (!first) {
    console.error(`${gpxAB}: track ilegible`);
    process.exit(1);
  }
  execFileSync('xcrun', ['simctl', 'location', udid, 'set', `${first[1]},${first[2]}`]);
  console.log(`ok · ${deviceName} de vuelta en la base A (${first[1]}, ${first[2]})`);
  process.exit(0);
}

const gpx = join(root, 'dev/routes', `driver-${leg}.gpx`);
const points = [...readFileSync(gpx, 'utf8').matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(
  (m) => `${m[1]},${m[2]}`,
);
if (points.length < 2) {
  console.error(`${gpx}: track vacío o ilegible`);
  process.exit(1);
}

// Waypoints por STDIN (modo `-`): las latitudes negativas por argv se parsean como flags de simctl.
execFileSync(
  'xcrun',
  ['simctl', 'location', udid, 'start', `--speed=${speed}`, '--interval=1', '-'],
  { input: points.join('\n') },
);
console.log(
  `ok · ${deviceName} manejando driver-${leg}.gpx (${points.length} waypoints @ ${speed} m/s). ` +
    `Al llegar, el sim queda en el último punto.`,
);
