/**
 * Gate de auto-omisión (mismo patrón que los specs de contrato BFF↔servicio: si el stack no está
 * arriba, el test se OMITE limpio en vez de fallar). La diferencia es que aquí, si la INFRA del
 * dev-stack SÍ está arriba, el harness se encarga de arrancar los servicios/BFFs (no hace falta
 * tenerlos corriendo a mano).
 *
 * Decisión:
 *  - Falta infra (Postgres/Redis/Kafka) o Docker  → skip (no se puede orquestar nada).
 *  - Infra OK                                       → corremos (el orquestador levanta el resto).
 *  - E2E_GOLDEN=force                               → corremos siempre (CI con stack garantizado).
 *  - E2E_GOLDEN=skip                                → omitimos siempre.
 */
import { execFileSync } from 'node:child_process';
import { INFRA } from './config.js';
import { pingTcp } from './wait.js';

export interface GateResult {
  ready: boolean;
  reason: string;
}

function parseHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  // Acepta "host:port", "redis://host:port", "postgresql://user:pass@host:port/db?..."
  let v = value;
  const at = v.lastIndexOf('@');
  if (at >= 0) v = v.slice(at + 1);
  const scheme = v.indexOf('://');
  if (scheme >= 0) v = v.slice(scheme + 3);
  v = v.split('/')[0] ?? v;
  const [host, portStr] = v.split(':');
  return { host: host || 'localhost', port: Number(portStr) || fallbackPort };
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['ps', '--format', '{{.Names}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function checkStack(): Promise<GateResult> {
  const forced = process.env.E2E_GOLDEN;
  if (forced === 'skip') return { ready: false, reason: 'E2E_GOLDEN=skip' };

  if (!dockerAvailable() && forced !== 'force') {
    return { ready: false, reason: 'Docker no disponible (se necesita para el dev-stack y el fixture de aprobación)' };
  }

  const pg = parseHostPort(INFRA.postgresUrlBase, 5433);
  const redis = parseHostPort(INFRA.redisUrl, 6379);
  const kafka = parseHostPort(INFRA.kafkaBroker, 9094);

  const [pgUp, redisUp, kafkaUp] = await Promise.all([
    pingTcp(pg.host, pg.port, 1200),
    pingTcp(redis.host, redis.port, 1200),
    pingTcp(kafka.host, kafka.port, 1200),
  ]);

  if (forced === 'force') return { ready: true, reason: 'E2E_GOLDEN=force' };

  const missing: string[] = [];
  if (!pgUp) missing.push(`Postgres ${pg.host}:${pg.port}`);
  if (!redisUp) missing.push(`Redis ${redis.host}:${redis.port}`);
  if (!kafkaUp) missing.push(`Kafka ${kafka.host}:${kafka.port}`);

  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Infra del dev-stack no disponible: ${missing.join(', ')}. Levanta con: pnpm dev-stack:up`,
    };
  }
  return { ready: true, reason: 'infra del dev-stack OK' };
}
