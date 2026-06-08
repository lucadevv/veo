/**
 * Fixtures de prueba (seed determinista). NO mockean dominio: preparan estado de entrada que en
 * producción provendría de otro canal (SMS real, operador humano que aprueba al conductor).
 *
 *  - injectOtp: el OTP llega por SMS (sandbox solo lo imprime en log, no es legible por API).
 *    Lo escribimos directo en Redis con el MISMO formato que OtpService (hash sha256, TTL), para
 *    que `POST /auth/otp/verify` lo acepte. Es el equivalente a "leer el SMS".
 *
 *  - approveDriver: la aprobación de antecedentes la hace un operador con rol admin (RBAC + TOTP).
 *    En el E2E del golden path saltamos ese sub-flujo de back-office aprobando directamente en la
 *    DB del identity-service (background_check_status=CLEARED + kyc_status=VERIFIED), vía
 *    `docker exec <pg> psql`. Es un seed de back-office, no parte del path a validar.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { INFRA } from './config.js';

const execFileAsync = promisify(execFile);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Normaliza un teléfono al MISMO formato canónico que `peruPhoneSchema` de @veo/utils, que es la
 * clave bajo la que OtpService guarda el OTP en Redis:
 *   quita no-dígitos → toma los últimos 9 dígitos → antepone '+51'  ⇒  '+51XXXXXXXXX'
 */
export function normalizePeruPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return `+51${digits.slice(-9)}`;
}

/**
 * Inyecta un OTP conocido en Redis para `phone`, replicando el registro de OtpService:
 *   key   = veo:otp:<phone>
 *   value = { hash: sha256(code), attempts: 0, issuedAt }
 *   TTL   = 300s
 */
export async function injectOtp(phone: string, code: string): Promise<void> {
  const normalized = normalizePeruPhone(phone);
  const redis = new Redis(INFRA.redisUrl);
  try {
    const record = JSON.stringify({ hash: sha256Hex(code), attempts: 0, issuedAt: Date.now() });
    await redis.set(`veo:otp:${normalized}`, record, 'EX', 300);
  } finally {
    redis.disconnect();
  }
}

/**
 * Limpia el hot index de dispatch en Redis (`driver:loc:*`, `driver:busy:*`, `h3:available:*`).
 * Sin esto, conductores "fantasma" de corridas anteriores (cuyo socket ya murió) pueden quedar como
 * candidatos y recibir la oferta primero → el matching espera su timeout y la prueba se vuelve flaky.
 */
export async function clearDispatchHotIndex(): Promise<void> {
  const redis = new Redis(INFRA.redisUrl);
  try {
    for (const pattern of ['driver:loc:*', 'driver:busy:*', 'h3:available:*']) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } finally {
    redis.disconnect();
  }
}

/**
 * Lee el modo de despacho CONGELADO de un viaje + su tarifa y estado directamente de la DB de trip
 * (schema `trip`, tabla `trips`). `dispatchMode` NO se expone en ninguna vista REST (es interno), así
 * que para asertarlo de forma AUTORITATIVA (y para la prueba persist-once) leemos la columna real.
 * Mismo patrón docker-exec que `approveDriverByUserId`. Devuelve null si el viaje no existe aún.
 */
export interface TripPricingRow {
  dispatchMode: string;
  fareCents: number;
  status: string;
}
export async function getTripPricingRow(tripId: string): Promise<TripPricingRow | null> {
  const sql = `SELECT dispatch_mode || '|' || fare_cents || '|' || status FROM trip.trips WHERE id='${tripId}';`;
  const { stdout } = await execFileAsync('docker', [
    'exec',
    INFRA.postgresContainer,
    'psql',
    '-U',
    'veo',
    '-d',
    'veo',
    '-tAc',
    sql,
  ]);
  const line = stdout.trim();
  if (!line) return null;
  const [dispatchMode, fareCents, status] = line.split('|');
  return { dispatchMode: dispatchMode ?? '', fareCents: Number(fareCents), status: status ?? '' };
}

/**
 * Aprueba al conductor en la DB de identity (seed de back-office). Marca antecedentes CLEARED y
 * el KYC del usuario VERIFIED, que es exactamente lo que hace `DriversService.approve`.
 * Devuelve true si actualizó una fila.
 */
export async function approveDriverByUserId(userId: string): Promise<boolean> {
  const sql = [
    `UPDATE identity.drivers SET background_check_status='CLEARED' WHERE user_id='${userId}';`,
    `UPDATE identity.users SET kyc_status='VERIFIED' WHERE id='${userId}';`,
    `SELECT count(*) FROM identity.drivers WHERE user_id='${userId}' AND background_check_status='CLEARED';`,
  ].join(' ');
  const { stdout } = await execFileAsync('docker', [
    'exec',
    INFRA.postgresContainer,
    'psql',
    '-U',
    'veo',
    '-d',
    'veo',
    '-tAc',
    sql,
  ]);
  return stdout.trim().endsWith('1');
}
