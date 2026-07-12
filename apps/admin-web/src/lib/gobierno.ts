/**
 * Metadata de presentación de Gobierno → Políticas (PBAC · ADR-024) para admin-web.
 *
 * La FUENTE DE VERDAD de la FORMA (familia, `mandatory`, defaults, schema Zod de `params`, textos base) es
 * `@veo/policy` (POLICY_CATALOG) — acá NO se re-declara ninguna de esas cosas (evita la deriva UI↔backend que
 * marca el ADR §9). Este módulo aporta solo la CAPA DE UI: íconos por familia/política, copy fino de cada
 * parámetro y un descriptor de campos DERIVADO del schema Zod del catálogo (para el editor genérico). Si el
 * catálogo agrega un parámetro nuevo, el editor lo renderiza solo con un label humanizado por defecto.
 */
import { z } from 'zod';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  ClipboardCheck,
  Database,
  Download,
  Eye,
  EyeOff,
  FileDown,
  Fingerprint,
  HardDriveDownload,
  Hourglass,
  KeyRound,
  LockKeyhole,
  Network,
  RefreshCw,
  Share2,
  Shield,
  ShieldCheck,
  Timer,
  Trash2,
  Video,
} from 'lucide-react';
import type { PolicyDef, PolicyFamily, PolicyKey, PolicyParams } from '@veo/policy';

/* ── Familias (orden y presentación del diseño AdminPoliticas) ── */

/** Orden de familias tal cual el diseño (Datos → Autenticación → Acceso → Restricciones operativas). */
export const FAMILY_ORDER: readonly PolicyFamily[] = ['data', 'auth', 'access', 'ops'];

export const FAMILY_META: Record<PolicyFamily, { label: string; icon: LucideIcon; hint: string }> = {
  data: {
    label: 'Datos y privacidad',
    icon: Database,
    hint: 'PII, video y retención — tratamiento del dato sensible (Ley 29733).',
  },
  auth: {
    label: 'Autenticación y sesión',
    icon: LockKeyhole,
    hint: 'MFA, step-up y frescura de sesión de los operadores.',
  },
  access: {
    label: 'Acceso',
    icon: KeyRound,
    hint: 'Alcance y condiciones del acceso: JIT, IP allowlist, recertificación.',
  },
  ops: {
    label: 'Restricciones operativas',
    icon: Download,
    hint: 'Operaciones de datos en volumen: exportación, share y descarga masiva.',
  },
};

/**
 * Políticas NET-NEW (ADR-024 §5): existen en el contrato pero AÚN NO tienen enforcement cableado (arrancan
 * `enabled:false`). Prenderlas hoy NO opera nada — se marca con el badge "enforcement en desarrollo" para no
 * mentir. Se hardcodea el set (en vez de inferirlo de `defaultEnabled:false`) para que quede explícito y no
 * derive si un default cambia. Fase 1/2 cablearán el enforcement real y estas saldrán de la lista.
 */
export const NET_NEW_POLICIES: ReadonlySet<PolicyKey> = new Set<PolicyKey>([
  'pii.reveal-stepup',
  'auth.session-timeout',
  'auth.daily-reauth',
  'access.jit',
  'access.ip-allowlist',
  'access.review',
  'ops.export',
  'ops.bulk-download',
]);

export function isNetNew(key: PolicyKey): boolean {
  return NET_NEW_POLICIES.has(key);
}

/** Ícono por política (fidelidad con el diseño; fallback al ícono de su familia si faltara). */
export const POLICY_ICONS: Record<PolicyKey, LucideIcon> = {
  'media.dual-auth': Video,
  'pii.mask': EyeOff,
  'pii.reveal-stepup': Eye,
  'media.retention': CalendarClock,
  'privacy.erasure': Trash2,
  'auth.mfa': ShieldCheck,
  'auth.stepup': Fingerprint,
  'auth.session-timeout': Timer,
  'auth.daily-reauth': RefreshCw,
  'access.jit': Hourglass,
  'access.ip-allowlist': Network,
  'access.review': ClipboardCheck,
  'access.least-privilege': Shield,
  'ops.export': FileDown,
  'ops.third-party-share': Share2,
  'ops.bulk-download': HardDriveDownload,
};

/* ── Parámetros: copy fino por clave de parámetro (presentación, NO contrato) ── */

interface ParamMeta {
  label: string;
  help?: string;
  /** Sufijo de unidad para números / resumen (p. ej. "s", "días"). */
  unit?: string;
}

/** Copy por clave de parámetro. `maxAgeSec` es compartido (reveal-stepup y auth.stepup): mismo significado. */
const PARAM_LABELS: Record<string, ParamMeta> = {
  approvers: {
    label: 'Aprobadores requeridos',
    help: 'Cuántas personas distintas deben aprobar cada acceso a video.',
    unit: 'aprobadores',
  },
  dniTail: {
    label: 'Dígitos visibles del DNI',
    help: 'Cuántos dígitos finales del DNI quedan a la vista; el resto se enmascara.',
    unit: 'dígitos',
  },
  revealRoles: {
    label: 'Quién ve la PII sin enmascarar',
    help: 'Roles que ven el DNI y datos personales completos, sin enmascarar.',
  },
  maxAgeSec: {
    label: 'Frescura de la MFA',
    help: 'Segundos que una verificación MFA se considera fresca antes de volver a pedirla.',
    unit: 's',
  },
  days: {
    label: 'Días de retención',
    help: 'Días que se conserva la grabación del viaje antes del barrido.',
    unit: 'días',
  },
  graceDays: {
    label: 'Días de gracia',
    help: 'Días antes de ejecutar el borrado definitivo de la cuenta (derecho al olvido).',
    unit: 'días',
  },
  idleMin: {
    label: 'Inactividad máxima',
    help: 'Minutos de inactividad antes de cerrar la sesión del operador.',
    unit: 'min',
  },
  ttlHours: {
    label: 'Vigencia del acceso',
    help: 'Horas antes de que expire un grant de acceso elevado (just-in-time).',
    unit: 'h',
  },
  cidrs: {
    label: 'Rangos CIDR permitidos',
    help: 'IPs o rangos autorizados en notación CIDR. Lista vacía = sin restricción.',
  },
  periodDays: {
    label: 'Periodo de recertificación',
    help: 'Días entre recertificaciones periódicas de acceso.',
    unit: 'días',
  },
  allowedRoles: {
    label: 'Roles habilitados',
    help: 'Roles autorizados para esta operación de datos. Lista vacía = nadie habilitado.',
  },
};

/** Parámetros que son un conjunto de ROLES (chips desde el set AdminRole), no strings libres (p. ej. CIDRs). */
const ROLE_PARAMS: ReadonlySet<string> = new Set(['revealRoles', 'allowedRoles']);

/** humaniza `dniTail` → "Dni tail" como último recurso si un parámetro nuevo no tiene copy. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/* ── Descriptor de campos DERIVADO del schema Zod del catálogo (editor genérico) ── */

export type ParamField =
  | {
      kind: 'number';
      key: string;
      label: string;
      help?: string;
      unit?: string;
      min: number | null;
      max: number | null;
    }
  | { kind: 'roles'; key: string; label: string; help?: string }
  | { kind: 'strings'; key: string; label: string; help?: string; unit?: string };

/**
 * Deriva los campos editables de una política LEYENDO su `paramsSchema` (ZodObject) del catálogo — no una lista
 * a mano. Números → stepper/input (con min/max del propio schema); arrays de roles → chips; arrays libres →
 * chips de texto (CIDRs). Políticas-flag (`z.object({})`) devuelven `[]` (solo el switch de `enabled`).
 */
export function describeParams(def: PolicyDef): ParamField[] {
  const schema = def.paramsSchema;
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = schema.shape as z.ZodRawShape;
  return Object.entries(shape).map(([key, field]) => {
    const meta = PARAM_LABELS[key] ?? { label: humanize(key) };
    if (field instanceof z.ZodNumber) {
      return {
        kind: 'number',
        key,
        label: meta.label,
        help: meta.help,
        unit: meta.unit,
        min: field.minValue,
        max: field.maxValue,
      };
    }
    if (field instanceof z.ZodArray && ROLE_PARAMS.has(key)) {
      return { kind: 'roles', key, label: meta.label, help: meta.help };
    }
    // Arrays libres (CIDRs) y cualquier forma no prevista → chips de texto libre (fallback seguro).
    return { kind: 'strings', key, label: meta.label, help: meta.help, unit: meta.unit };
  });
}

/** ¿La política tiene parámetros configurables? (false = flag puro, solo on/off). */
export function isConfigurable(def: PolicyDef): boolean {
  return describeParams(def).length > 0;
}

/* ── Regla PBAC (WHEN/THEN) DERIVADA de la config existente (presentación, NO backend nuevo · detalle jznes) ──
 *
 * La regla NO se guarda en ningún lado: es la traducción LEGIBLE de lo que la política HACE, derivada de su key
 * (semántica del catálogo · ADR-024 §5) + sus `params` vigentes. Es "presentación de la config existente" (no un
 * contrato del wire): la página del detalle ya recibe `params` en el `PolicyView`, así que la regla se computa
 * client-side. Honesto: solo se afirma lo que la política realmente enforcea; los números salen de `params`. */

/** Una fila de la regla: término (izq, mono) ▸ valor (der). */
export interface RuleClause {
  term: string;
  value: string;
}

/** Regla WHEN/THEN derivada: condición(es) que disparan la política ▸ efecto(s) que aplica. */
export interface DerivedRule {
  when: RuleClause[];
  then: RuleClause[];
}

/** Lee un `params[key]` numérico con fallback (los params ya vienen validados; el fallback cubre faltantes). */
function pNum(params: PolicyParams, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Lee un `params[key]` array-de-strings (roles / CIDRs). */
function pList(params: PolicyParams, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Constructores de regla por política. Cada uno traduce key + params → WHEN/THEN legible. Es la fuente única de
 * la traducción (16 entradas, `satisfies` garantiza que están TODAS): agregar una política obliga a declarar su
 * regla. NO inventa efectos que la política no tenga — refleja la semántica real del catálogo (§5) con los `params`.
 */
const RULE_BUILDERS = {
  'media.dual-auth': (p) => ({
    when: [{ term: 'acción', value: 'acceder a la grabación de un viaje' }],
    then: [
      { term: 'requiere', value: `aprobación de ${pNum(p, 'approvers', 2)} personas distintas` },
      { term: 'four-eyes', value: 'identidad + rol distintos por aprobador' },
    ],
  }),
  'pii.mask': (p) => {
    const roles = pList(p, 'revealRoles');
    return {
      when: [
        { term: 'acción', value: 'mostrar DNI / datos personales' },
        { term: 'excepto', value: roles.length ? roles.join(', ') : '— (nadie)' },
      ],
      then: [{ term: 'efecto', value: `enmascarar · dejar ${pNum(p, 'dniTail', 4)} dígitos visibles` }],
    };
  },
  'pii.reveal-stepup': (p) => ({
    when: [{ term: 'acción', value: 'revelar el DNI / PII completo' }],
    then: [{ term: 'requiere', value: `MFA fresca (< ${pNum(p, 'maxAgeSec', 600)} s)` }],
  }),
  'media.retention': (p) => ({
    when: [{ term: 'condición', value: `la grabación supera ${pNum(p, 'days', 30)} días` }],
    then: [{ term: 'efecto', value: 'barrido / eliminación de la grabación' }],
  }),
  'privacy.erasure': (p) => ({
    when: [{ term: 'acción', value: 'se solicita el borrado de la cuenta' }],
    then: [
      { term: 'gracia', value: `esperar ${pNum(p, 'graceDays', 30)} días` },
      { term: 'luego', value: 'borrado definitivo (tombstone)' },
    ],
  }),
  'auth.mfa': () => ({
    when: [{ term: 'acción', value: 'un operador inicia sesión' }],
    then: [{ term: 'requiere', value: 'segundo factor (MFA)' }],
  }),
  'auth.stepup': (p) => ({
    when: [{ term: 'acción', value: 'ejecutar una acción sensible' }],
    then: [{ term: 'requiere', value: `MFA fresca (< ${pNum(p, 'maxAgeSec', 300)} s)` }],
  }),
  'auth.session-timeout': (p) => ({
    when: [{ term: 'condición', value: `inactividad > ${pNum(p, 'idleMin', 30)} min` }],
    then: [{ term: 'efecto', value: 'cerrar la sesión (re-login)' }],
  }),
  'auth.daily-reauth': () => ({
    when: [{ term: 'condición', value: 'pasó 1 día desde la última re-autenticación' }],
    then: [{ term: 'efecto', value: 'forzar re-autenticación completa' }],
  }),
  'access.jit': (p) => ({
    when: [{ term: 'acción', value: 'se concede un acceso elevado' }],
    then: [{ term: 'efecto', value: `expira tras ${pNum(p, 'ttlHours', 8)} h` }],
  }),
  'access.ip-allowlist': (p) => {
    const cidrs = pList(p, 'cidrs');
    return cidrs.length
      ? {
          when: [{ term: 'condición', value: `la IP no está en ${cidrs.length} rango(s) CIDR` }],
          then: [{ term: 'efecto', value: 'denegar el acceso admin' }],
        }
      : {
          when: [{ term: 'condición', value: 'lista vacía' }],
          then: [{ term: 'efecto', value: 'sin restricción (no bloquea a nadie)' }],
        };
  },
  'access.review': (p) => ({
    when: [
      { term: 'condición', value: `pasaron ${pNum(p, 'periodDays', 90)} días desde la última recertificación` },
    ],
    then: [{ term: 'efecto', value: 'exigir recertificar los accesos' }],
  }),
  'access.least-privilege': () => ({
    when: [{ term: 'acción', value: 'un rol solicita un recurso' }],
    then: [
      { term: 'efecto', value: 'conceder solo lo estrictamente necesario' },
      { term: 'base', value: 'RBAC + redacción default-null' },
    ],
  }),
  'ops.export': (p) => {
    const roles = pList(p, 'allowedRoles');
    return {
      when: [
        { term: 'condición', value: roles.length ? `el rol no está en {${roles.join(', ')}}` : 'ningún rol habilitado' },
      ],
      then: [{ term: 'efecto', value: 'denegar exportar datasets' }],
    };
  },
  'ops.third-party-share': () => ({
    when: [{ term: 'acción', value: 'compartir datos con un tercero' }],
    then: [{ term: 'efecto', value: 'permitir (feature de producto, on/off)' }],
  }),
  'ops.bulk-download': (p) => {
    const roles = pList(p, 'allowedRoles');
    return {
      when: [
        { term: 'condición', value: roles.length ? `el rol no está en {${roles.join(', ')}}` : 'ningún rol habilitado' },
      ],
      then: [{ term: 'efecto', value: 'denegar la descarga masiva' }],
    };
  },
} satisfies Record<PolicyKey, (params: PolicyParams) => DerivedRule>;

/** Traduce una política (key + params vigentes) a su regla WHEN/THEN legible. Presentación, no backend. */
export function derivePolicyRule(def: PolicyDef, params: PolicyParams): DerivedRule {
  return RULE_BUILDERS[def.key](params);
}

/* ── Alcance (roles / recursos que la política TARGETEA) DERIVADO de sus params, o "global" ── */

/**
 * Alcance de una política: si sus `params` targetean roles (pii.mask.revealRoles, ops.*.allowedRoles) o rangos
 * CIDR (access.ip-allowlist.cidrs), se listan; el resto es GLOBAL (aplica a todos los roles / todo el acceso). Se
 * DERIVA de la config real — no se inventa un alcance que la política no declare. */
export type DerivedScope =
  | { kind: 'roles'; roles: string[] }
  | { kind: 'cidrs'; cidrs: string[] }
  | { kind: 'global' };

export function derivePolicyScope(def: PolicyDef, params: PolicyParams): DerivedScope {
  switch (def.key) {
    case 'pii.mask':
      return { kind: 'roles', roles: pList(params, 'revealRoles') };
    case 'ops.export':
    case 'ops.bulk-download':
      return { kind: 'roles', roles: pList(params, 'allowedRoles') };
    case 'access.ip-allowlist':
      return { kind: 'cidrs', cidrs: pList(params, 'cidrs') };
    default:
      return { kind: 'global' };
  }
}

/** Resumen corto del PRIMER parámetro para el chip de la fila (p. ej. "2 aprobadores", "30 min", "2 roles"). */
export function paramChipSummary(def: PolicyDef, params: Record<string, unknown>): string | null {
  const [first] = describeParams(def);
  if (!first) return null;
  const raw = params[first.key];
  if (first.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(n)) return null;
    return first.unit ? `${n} ${first.unit}` : String(n);
  }
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.length === 0) return first.kind === 'roles' ? 'sin roles' : 'sin reglas';
  return first.kind === 'roles'
    ? `${arr.length} ${arr.length === 1 ? 'rol' : 'roles'}`
    : `${arr.length} ${first.unit ?? 'reglas'}`;
}
