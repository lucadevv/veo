/**
 * Helper para hablar con el endpoint INTERNO del schedule de modo de pricing de trip-service
 * (ADR 011 §3/§6) SIN levantar admin-bff. trip-service protege esas rutas con InternalIdentityGuard
 * (firma HMAC del header `x-veo-identity` + `x-veo-identity-sig`) y, para el PUT, AdminIdentityGuard
 * (la identidad firmada debe ser `type === 'admin'`).
 *
 * Replicamos EXACTAMENTE lo que hace un BFF: serializamos la identidad a base64url, la firmamos con
 * HMAC-SHA256 usando el INTERNAL_IDENTITY_SECRET compartido (el MISMO que el harness inyecta a todos
 * los procesos en config.ts → commonEnv), y lo mandamos en los headers. Es un "admin-bff de una línea":
 * en prod admin-bff valida el JWT + RBAC `pricing:manage`; acá inyectamos directo la identidad admin
 * firmada, que es justo lo que trip-service confía (decisión: validación en el borde/BFF).
 *
 * NO mockea dominio: el PUT corre la lógica REAL de PricingScheduleService (persiste la fila +
 * bump version + emite pricing.mode_schedule_updated), y el resolver real (resolveMode) decide el modo.
 */
import { createHmac } from 'node:crypto';
import { SECRETS, PORTS } from './config.js';

/** Mismos nombres de header que @veo/auth (INTERNAL_IDENTITY_HEADER / _SIG_HEADER). */
const IDENTITY_HEADER = 'x-veo-identity';
const IDENTITY_SIG_HEADER = 'x-veo-identity-sig';

const TRIP_BASE = `http://localhost:${PORTS.trip}/api/v1`;

/** Modo de pricing (espeja PricingMode de @veo/shared-types). */
export type PricingMode = 'PUJA' | 'FIXED';

/** Una regla horaria del schedule (hora local de Lima). */
export interface PricingModeRule {
  /** Bitmask Lun=1..Dom=64 (1..127). */
  dayMask: number;
  /** Minuto del día (0..1439) en hora local de Lima, inicio del rango [start,end). */
  startMinute: number;
  /** Minuto del día (0..1439), fin EXCLUSIVO del rango. */
  endMinute: number;
  mode: PricingMode;
}

export interface ModeSchedule {
  defaultMode: PricingMode;
  rules: PricingModeRule[];
}

/**
 * Firma una identidad interna admin igual que `signInternalIdentity` de @veo/auth:
 * header = base64url(JSON({ ...user, issuedAt })), signature = HMAC-SHA256(header, secret).
 */
function signAdminIdentity(): { header: string; signature: string } {
  const identity = {
    userId: '00000000-0000-0000-0000-0000000000ad',
    type: 'admin' as const,
    roles: ['SUPERADMIN'],
    sessionId: 'e2e-admin-session',
    issuedAt: Date.now(),
  };
  const header = Buffer.from(JSON.stringify(identity)).toString('base64url');
  const signature = createHmac('sha256', SECRETS.internalIdentitySecret)
    .update(header)
    .digest('hex');
  return { header, signature };
}

function adminHeaders(): Record<string, string> {
  const { header, signature } = signAdminIdentity();
  return {
    'content-type': 'application/json',
    [IDENTITY_HEADER]: header,
    [IDENTITY_SIG_HEADER]: signature,
  };
}

/**
 * PUT /internal/pricing/mode-schedule — REEMPLAZA wholesale el schedule (ADR 011 §6). Devuelve el
 * status HTTP y el body (la vista del schedule persistido, con version bumpeada). Lanza si !ok para
 * que el test vea el error real.
 */
export async function putModeSchedule(
  schedule: ModeSchedule,
): Promise<{ status: number; body: unknown }> {
  // CAS (optimistic locking): el DTO EXIGE `expectedVersion`. Resolvemos la version vigente (fresh = 0)
  // y reemplazamos desde ahí → robusto para el primer write y para llamadas repetidas en la misma corrida.
  const current = await getModeSchedule();
  const expectedVersion = (current.body as { version?: number } | undefined)?.version ?? 0;
  const res = await fetch(`${TRIP_BASE}/internal/pricing/mode-schedule`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ ...schedule, expectedVersion }),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new Error(
      `PUT mode-schedule → ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return { status: res.status, body };
}

/** GET /internal/pricing/mode-schedule — el schedule vigente (o el default PUJA). */
export async function getModeSchedule(): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${TRIP_BASE}/internal/pricing/mode-schedule`, {
    method: 'GET',
    headers: adminHeaders(),
  });
  const text = await res.text();
  return { status: res.status, body: text ? safeJson(text) : undefined };
}

/** GET /internal/pricing/resolve?lat&lon — el modo { mode } para (lat,lon, AHORA). */
export async function resolveMode(
  lat: number,
  lon: number,
): Promise<{ status: number; mode?: string }> {
  const url = new URL(`${TRIP_BASE}/internal/pricing/resolve`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  const res = await fetch(url, { method: 'GET', headers: adminHeaders() });
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  return { status: res.status, mode: (body as { mode?: string } | undefined)?.mode };
}

/**
 * Construye una regla que cubre el AHORA de Lima → `mode`, con un margen amplio alrededor del minuto
 * actual para que la prueba no curse en una frontera de minuto. dayMask = el día de hoy en Lima.
 * Si el rango se saliera del día (madrugada/medianoche), lo clampa a [0,1440) — el caller debe estar
 * lejos de los bordes para una ventana amplia; el clamp evita un rango inválido en horas extremas.
 */
export function ruleCoveringNow(mode: PricingMode, marginMin = 120): PricingModeRule {
  // Lima = UTC-5 fijo (sin DST). minuto del día y weekday local.
  const LIMA_OFFSET_MIN = -300;
  const limaMs = Date.now() + LIMA_OFFSET_MIN * 60_000;
  const limaDate = new Date(limaMs);
  // getUTC* sobre el instante ya desplazado nos da los componentes "locales de Lima".
  const minuteOfDay = limaDate.getUTCHours() * 60 + limaDate.getUTCMinutes();
  // getUTCDay: 0=Dom..6=Sáb → ISO Lun=1..Dom=7.
  const jsDay = limaDate.getUTCDay();
  const isoWeekday = jsDay === 0 ? 7 : jsDay;
  const dayMask = 1 << (isoWeekday - 1);
  const startMinute = Math.max(0, minuteOfDay - marginMin);
  const endMinute = Math.min(1439, minuteOfDay + marginMin);
  return { dayMask, startMinute, endMinute, mode };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
