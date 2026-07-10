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
import type { PolicyDef, PolicyFamily, PolicyKey } from '@veo/policy';

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
