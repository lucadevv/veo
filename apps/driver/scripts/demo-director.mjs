#!/usr/bin/env node
/**
 * DEV · DIRECTOR de la demo — cose los ESTADOS del viaje con los TRAMOS GPX del simulador.
 *
 * Problema que resuelve: los tramos (simulate-route.mjs a-b / b-c) se disparaban A MANO, y si el
 * timing no calzaba con la máquina de estados (aceptar con la ruta ya terminada, iniciar sin cargar
 * b-c), el conductor "aparecía" en B sin haber manejado y la UI quedaba descoordinada de la fase.
 *
 * Este director POLLEA el estado REAL del viaje (la DB de trip-service, cada 2s) y dispara el tramo
 * que corresponde en el GPS del simulador — el flujo queda como el real, sin tocar nada:
 *
 *   ACCEPTED / ARRIVING   → maneja A→B (hacia el recojo; si venía de otra demo, teletransporta a A)
 *   ARRIVED               → (la ruta a-b ya lo dejó quieto en B — no hace nada)
 *   IN_PROGRESS           → maneja B→C (pasajero a bordo)
 *   COMPLETED/terminal    → corta la simulación (el sim queda quieto donde terminó)
 *
 * Uso:  node scripts/demo-director.mjs        (dejalo corriendo en una terminal; Ctrl+C para salir)
 * Luego usá las DOS apps con normalidad: pedir → aceptar → he llegado → iniciar → completar.
 * Requiere el stack local vivo (docker veo-postgres) y el simulador del conductor booteado.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const POLL_MS = 2000;

/** Base del conductor (fija, dentro del radio de matching). El recojo y el destino salen del viaje REAL. */
const A = { lat: -12.008193, lon: -77.059937 };

// Token de Mapbox para que el sim maneje por el MISMO camino que ven las apps (dev/local rutean mapbox).
// Lo tomamos del env o del env/local.env del driver-bff; si no está, gen-gpx cae a OSRM :5005 (también real).
function mapboxToken() {
  if (process.env.MAPBOX_ACCESS_TOKEN) return process.env.MAPBOX_ACCESS_TOKEN;
  try {
    const envf = join(scriptsDir, '..', '..', '..', 'services', 'bff', 'driver-bff', 'env', 'local.env');
    return readFileSync(envf, 'utf8').match(/^MAPBOX_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}
const MAPBOX = mapboxToken();

/** Regenera un tramo GPX (from→to) al vuelo hacia el destino REAL del viaje. Best-effort: si falla el
 *  ruteo, deja el GPX existente (el sim igual maneja algo) y sigue. */
function regenLeg(file, from, to) {
  if (!from?.lat || !to?.lat) {
    console.log(`  · sin coords para regenerar ${file}; uso el GPX existente`);
    return;
  }
  try {
    execFileSync(
      'node',
      [
        join(scriptsDir, 'gen-gpx-from-service.mjs'),
        `--from=${from.lat},${from.lon}`,
        `--to=${to.lat},${to.lon}`,
        `--file=${file}`,
      ],
      { stdio: 'inherit', env: { ...process.env, MAPBOX_ACCESS_TOKEN: MAPBOX } },
    );
  } catch (err) {
    console.error(`  ⚠️  no pude regenerar ${file} (uso el existente):`, err.message);
  }
}

/** Estados en los que el conductor va HACIA el recojo (tramo a-b). */
const TO_PICKUP = new Set(['ASSIGNED', 'ACCEPTED', 'ARRIVING']);
/** Estados terminales: se corta la simulación y se espera el próximo viaje. */
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REASSIGNING']);

function latestTrip() {
  const out = spawnSync(
    'docker',
    [
      'exec',
      'veo-postgres',
      'psql',
      '-U',
      'veo',
      '-d',
      'veo',
      '-t',
      '-A',
      '-c',
      "SELECT id || '|' || status || '|' || COALESCE(origin_lat::text,'') || '|' || " +
        "COALESCE(origin_lon::text,'') || '|' || COALESCE(dest_lat::text,'') || '|' || " +
        "COALESCE(dest_lon::text,'') FROM trip.trips ORDER BY requested_at DESC LIMIT 1;",
    ],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) return null;
  const line = out.stdout.trim();
  if (!line) return null;
  const [id, status, oLat, oLon, dLat, dLon] = line.split('|');
  const pt = (lat, lon) =>
    lat && lon ? { lat: Number(lat), lon: Number(lon) } : null;
  // origin = recojo (B real), dest = destino (C real) — de la DB del viaje.
  return { id, status, origin: pt(oLat, oLon), dest: pt(dLat, dLon) };
}

function runLeg(leg) {
  execFileSync('node', [join(scriptsDir, 'simulate-route.mjs'), leg], { stdio: 'inherit' });
}

console.log('🎬 director de demo: mirando los estados del viaje (Ctrl+C para salir)…');

// Qué tramo ya disparamos por viaje (para no relanzar en cada poll del mismo estado).
let currentTripId = null;
let firedLeg = null; // null | 'a-b' | 'b-c' | 'stop'
let lastLogged = '';

setInterval(() => {
  const trip = latestTrip();
  if (!trip) return;

  if (trip.id !== currentTripId) {
    currentTripId = trip.id;
    firedLeg = null;
  }

  const key = `${trip.id.slice(0, 8)}:${trip.status}`;
  if (key !== lastLogged) {
    console.log(`· viaje ${trip.id.slice(0, 8)} → ${trip.status}`);
    lastLogged = key;
  }

  try {
    if (TO_PICKUP.has(trip.status) && firedLeg !== 'a-b' && firedLeg !== 'b-c') {
      console.log('  🏍  ACCEPTED → manejando A→recojo REAL del viaje');
      regenLeg('driver-a-b.gpx', A, trip.origin); // base → recojo real
      runLeg('a-b');
      firedLeg = 'a-b';
    } else if (trip.status === 'IN_PROGRESS' && firedLeg !== 'b-c') {
      console.log('  🛣  IN_PROGRESS → manejando recojo→DESTINO REAL del viaje (pasajero a bordo)');
      regenLeg('driver-b-c.gpx', trip.origin, trip.dest); // recojo real → destino real
      runLeg('b-c');
      firedLeg = 'b-c';
    } else if (TERMINAL.has(trip.status) && firedLeg !== 'stop' && firedLeg !== null) {
      console.log(`  🏁 ${trip.status} → corto la simulación y vuelvo a la BASE A (listo para el próximo pedido)`);
      runLeg('stop');
      runLeg('base');
      firedLeg = 'stop';
    }
  } catch (err) {
    console.error('  ⚠️  no pude disparar el tramo:', err.message);
  }
}, POLL_MS);
