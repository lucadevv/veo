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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const POLL_MS = 2000;

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
      "SELECT id || '|' || status FROM trip.trips ORDER BY requested_at DESC LIMIT 1;",
    ],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) return null;
  const line = out.stdout.trim();
  if (!line) return null;
  const [id, status] = line.split('|');
  return { id, status };
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
      console.log('  🏍  ACCEPTED → manejando A→B (hacia el recojo)');
      runLeg('a-b');
      firedLeg = 'a-b';
    } else if (trip.status === 'IN_PROGRESS' && firedLeg !== 'b-c') {
      console.log('  🛣  IN_PROGRESS → manejando B→C (pasajero a bordo)');
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
