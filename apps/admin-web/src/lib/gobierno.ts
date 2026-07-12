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
import { AdminRole } from '@veo/shared-types';
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
import { roleMeta } from './gobierno/permissions';

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
 * Semántica PBAC técnica por política (vocabulario del board `jznes`: `action`/`resource` + acciones/recursos/roles
 * del Alcance). NO es contrato del wire — es la traducción LEGIBLE de lo que la política gobierna, en el mismo
 * vocabulario técnico del diseño. Los `roles` salen de `PERMISSION_ROLES` real (@veo/policy): son los roles que la
 * política ALCANZA (los que ejercen la acción gobernada), no un set inventado. `apps` = frontends donde el efecto
 * es visible. Honesto: describe la semántica real del catálogo (§5), no fabrica efectos que la política no tenga.
 */
const R = AdminRole;
/** Los 7 roles admin (orden del ADR) — una política "global" alcanza a todos. */
const ALL_ROLES: readonly AdminRole[] = [
  R.SUPPORT_L1,
  R.SUPPORT_L2,
  R.DISPATCHER,
  R.COMPLIANCE_SUPERVISOR,
  R.FINANCE,
  R.ADMIN,
  R.SUPERADMIN,
];

interface PolicySemantics {
  /** Acciones (técnicas) que la política gobierna → chips del Alcance. */
  acciones: readonly string[];
  /** Recursos (técnicos) sobre los que aplica → chips del Alcance. */
  recursos: readonly string[];
  /**
   * Roles ALCANZADOS: lista fija de `PERMISSION_ROLES`, `'all'` (los 7), o `'param'` (se lee de los `params`
   * role-scoped: revealRoles / allowedRoles). Fuente real — no inventa roles.
   */
  roles: readonly AdminRole[] | 'all' | 'param';
  /** Frontends donde el efecto de la política es visible. */
  apps: readonly string[];
}

const POLICY_SEMANTICS: Record<PolicyKey, PolicySemantics> = {
  // Acceso a grabación exige four-eyes. Roles = quienes pueden acceder a video (media:view) = CMP/ADM/SUP.
  'media.dual-auth': {
    acciones: ['video.access'],
    recursos: ['recorded_video', 'live_stream'],
    roles: [R.COMPLIANCE_SUPERVISOR, R.ADMIN, R.SUPERADMIN],
    apps: ['admin'],
  },
  // Enmascarado universal del DNI/PII; la excepción (quién ve sin enmascarar) sale de revealRoles (param).
  'pii.mask': {
    acciones: ['pii.render'],
    recursos: ['dni', 'personal_data'],
    roles: 'param',
    apps: ['admin', 'family'],
  },
  'pii.reveal-stepup': {
    acciones: ['pii.reveal'],
    recursos: ['dni', 'personal_data'],
    roles: [R.COMPLIANCE_SUPERVISOR, R.ADMIN, R.SUPERADMIN],
    apps: ['admin'],
  },
  'media.retention': {
    acciones: ['media.sweep'],
    recursos: ['recorded_video'],
    roles: 'all',
    apps: ['admin'],
  },
  'privacy.erasure': {
    acciones: ['account.erase'],
    recursos: ['pii', 'account_data'],
    roles: 'all',
    apps: ['admin', 'passenger', 'family'],
  },
  'auth.mfa': {
    acciones: ['operator.login'],
    recursos: ['admin_session'],
    roles: 'all',
    apps: ['admin'],
  },
  'auth.stepup': {
    acciones: ['sensitive.action'],
    recursos: ['admin_session'],
    roles: 'all',
    apps: ['admin'],
  },
  'auth.session-timeout': {
    acciones: ['session.idle'],
    recursos: ['admin_session'],
    roles: 'all',
    apps: ['admin'],
  },
  'auth.daily-reauth': {
    acciones: ['session.daily'],
    recursos: ['admin_session'],
    roles: 'all',
    apps: ['admin'],
  },
  'access.jit': {
    acciones: ['access.grant'],
    recursos: ['elevated_access'],
    roles: 'all',
    apps: ['admin'],
  },
  'access.ip-allowlist': {
    acciones: ['access.connect'],
    recursos: ['admin_endpoint'],
    roles: 'all',
    apps: ['admin'],
  },
  'access.review': {
    acciones: ['access.recertify'],
    recursos: ['role_grant'],
    roles: 'all',
    apps: ['admin'],
  },
  'access.least-privilege': {
    acciones: ['resource.access'],
    recursos: ['any_resource'],
    roles: 'all',
    apps: ['admin'],
  },
  'ops.export': {
    acciones: ['data.export'],
    recursos: ['dataset'],
    roles: 'param',
    apps: ['admin'],
  },
  'ops.third-party-share': {
    acciones: ['data.share'],
    recursos: ['user_data'],
    roles: 'all',
    apps: ['admin'],
  },
  'ops.bulk-download': {
    acciones: ['data.bulk-download'],
    recursos: ['dataset'],
    roles: 'param',
    apps: ['admin'],
  },
};

/**
 * Roles ALCANZADOS reales (resueltos): `'all'`→los 7, `'param'`→los del set role-scoped (revealRoles/allowedRoles
 * TAL CUAL están configurados — no se filtran ni normalizan, así se refleja la config real aunque use una etiqueta
 * suelta como `COMPLIANCE`), o la lista fija de `PERMISSION_ROLES`. Devuelve strings porque los params son strings.
 */
export function policyRoles(def: PolicyDef, params: PolicyParams): readonly string[] {
  const sem = POLICY_SEMANTICS[def.key];
  if (sem.roles === 'all') return ALL_ROLES;
  if (sem.roles === 'param') {
    return pList(params, def.key === 'pii.mask' ? 'revealRoles' : 'allowedRoles');
  }
  return sem.roles;
}

/**
 * Constructores de regla por política. Cada uno traduce key + params → WHEN/THEN en el vocabulario PBAC TÉCNICO del
 * board (`action`/`resource` ▸ `require`/`effect`), con los valores VIGENTES de `params`. Fuente única (16 entradas,
 * `satisfies` garantiza que están TODAS). NO inventa efectos ni valores que la política no tenga (p. ej. no hay
 * `ttl` en dual-auth → no se muestra): refleja la semántica real del catálogo (§5).
 */
const RULE_BUILDERS = {
  'media.dual-auth': (p) => ({
    when: [
      { term: 'action', value: 'video.access' },
      { term: 'resource', value: 'recorded_video' },
    ],
    then: [
      { term: 'require', value: 'two_person_approval' },
      { term: 'approvers', value: `× ${pNum(p, 'approvers', 2)}` },
      { term: 'four_eyes', value: 'identity + role' },
    ],
  }),
  'pii.mask': (p) => {
    const roles = pList(p, 'revealRoles');
    return {
      when: [
        { term: 'action', value: 'pii.render' },
        { term: 'resource', value: 'dni · personal_data' },
      ],
      then: [
        { term: 'effect', value: 'mask' },
        { term: 'keep', value: `${pNum(p, 'dniTail', 4)} digits` },
        { term: 'except', value: roles.length ? roles.join(' · ').toLowerCase() : '∅' },
      ],
    };
  },
  'pii.reveal-stepup': (p) => ({
    when: [{ term: 'action', value: 'pii.reveal' }],
    then: [
      { term: 'require', value: 'fresh_mfa' },
      { term: 'max_age', value: `${pNum(p, 'maxAgeSec', 600)}s` },
    ],
  }),
  'media.retention': (p) => ({
    when: [
      { term: 'resource', value: 'recorded_video' },
      { term: 'age', value: `> ${pNum(p, 'days', 30)} days` },
    ],
    then: [{ term: 'effect', value: 'sweep · delete' }],
  }),
  'privacy.erasure': (p) => ({
    when: [{ term: 'action', value: 'account.erase' }],
    then: [
      { term: 'grace', value: `${pNum(p, 'graceDays', 30)} days` },
      { term: 'then', value: 'tombstone' },
    ],
  }),
  'auth.mfa': () => ({
    when: [{ term: 'action', value: 'operator.login' }],
    then: [{ term: 'require', value: 'second_factor' }],
  }),
  'auth.stepup': (p) => ({
    when: [{ term: 'action', value: 'sensitive.action' }],
    then: [
      { term: 'require', value: 'fresh_mfa' },
      { term: 'max_age', value: `${pNum(p, 'maxAgeSec', 300)}s` },
    ],
  }),
  'auth.session-timeout': (p) => ({
    when: [
      { term: 'resource', value: 'admin_session' },
      { term: 'idle', value: `> ${pNum(p, 'idleMin', 30)} min` },
    ],
    then: [{ term: 'effect', value: 'logout · re-login' }],
  }),
  'auth.daily-reauth': () => ({
    when: [{ term: 'condition', value: 'age > 1 day' }],
    then: [{ term: 'effect', value: 'force_reauth' }],
  }),
  'access.jit': (p) => ({
    when: [{ term: 'action', value: 'access.grant' }],
    then: [{ term: 'expires', value: `${pNum(p, 'ttlHours', 8)}h` }],
  }),
  'access.ip-allowlist': (p) => {
    const cidrs = pList(p, 'cidrs');
    return cidrs.length
      ? {
          when: [
            { term: 'action', value: 'access.connect' },
            { term: 'ip', value: `∉ ${cidrs.length} cidr` },
          ],
          then: [{ term: 'effect', value: 'deny' }],
        }
      : {
          when: [{ term: 'cidrs', value: '∅ (empty)' }],
          then: [{ term: 'effect', value: 'allow_all' }],
        };
  },
  'access.review': (p) => ({
    when: [
      { term: 'resource', value: 'role_grant' },
      { term: 'age', value: `> ${pNum(p, 'periodDays', 90)} days` },
    ],
    then: [{ term: 'effect', value: 'recertify' }],
  }),
  'access.least-privilege': () => ({
    when: [{ term: 'action', value: 'resource.access' }],
    then: [
      { term: 'effect', value: 'grant_minimal' },
      { term: 'base', value: 'rbac · default_null' },
    ],
  }),
  'ops.export': (p) => {
    const roles = pList(p, 'allowedRoles');
    return {
      when: [
        { term: 'action', value: 'data.export' },
        { term: 'role', value: roles.length ? `∉ {${roles.join(', ').toLowerCase()}}` : '∅ allowed' },
      ],
      then: [{ term: 'effect', value: 'deny' }],
    };
  },
  'ops.third-party-share': () => ({
    when: [{ term: 'action', value: 'data.share' }],
    then: [{ term: 'effect', value: 'allow (product_flag)' }],
  }),
  'ops.bulk-download': (p) => {
    const roles = pList(p, 'allowedRoles');
    return {
      when: [
        { term: 'action', value: 'data.bulk-download' },
        { term: 'role', value: roles.length ? `∉ {${roles.join(', ').toLowerCase()}}` : '∅ allowed' },
      ],
      then: [{ term: 'effect', value: 'deny' }],
    };
  },
} satisfies Record<PolicyKey, (params: PolicyParams) => DerivedRule>;

/** Traduce una política (key + params vigentes) a su regla WHEN/THEN técnica. Presentación, no backend. */
export function derivePolicyRule(def: PolicyDef, params: PolicyParams): DerivedRule {
  return RULE_BUILDERS[def.key](params);
}

/* ── Alcance: 3 filas del board (Acciones / Recursos / Roles alcanzados) DERIVADAS de la semántica + params ── */

/** Una fila del Alcance: label + chips (mono). `emptyHint` cuando el set está vacío (honesto, no oculta). */
export interface ScopeRowData {
  label: string;
  chips: string[];
  emptyHint?: string;
}

/**
 * Las 3 filas del Alcance del board: Acciones (técnicas) · Recursos (técnicos) · Roles alcanzados (labels de rol,
 * de `PERMISSION_ROLES` real o de los params role-scoped). Para `access.ip-allowlist` la 3ra fila son los rangos
 * CIDR configurados (su "scope" real). Todo DERIVADO — nada inventado. */
export function derivePolicyScopeRows(def: PolicyDef, params: PolicyParams): ScopeRowData[] {
  const sem = POLICY_SEMANTICS[def.key];
  const rows: ScopeRowData[] = [
    { label: 'Acciones', chips: [...sem.acciones] },
    { label: 'Recursos', chips: [...sem.recursos] },
  ];
  if (def.key === 'access.ip-allowlist') {
    const cidrs = pList(params, 'cidrs');
    rows.push({
      label: 'Rangos IP',
      chips: cidrs,
      emptyHint: 'Lista vacía — sin restricción de IP',
    });
    return rows;
  }
  const roles = policyRoles(def, params);
  rows.push({
    label: 'Roles alcanzados',
    chips: roles.map((r) => roleMeta(r)?.label ?? r),
    emptyHint:
      sem.roles === 'param' ? 'Ningún rol — la política no habilita a nadie' : undefined,
  });
  return rows;
}

/* ── Impacto (blast-radius): stats REALES del footprint de la política ── */

export interface PolicyFootprint {
  acciones: number;
  recursos: number;
  roles: number;
  apps: number;
}

/**
 * Footprint de una política: cuántas acciones/recursos gobierna, cuántos roles alcanza y en cuántas apps se ve el
 * efecto. Todo DERIVADO de la semántica real (`PERMISSION_ROLES`, params). Reemplaza los "6 Endpoints" del board,
 * que no son computables (el enforcement son lecturas dispersas del `PolicyReader`, no un decorator por-ruta). */
export function derivePolicyFootprint(def: PolicyDef, params: PolicyParams): PolicyFootprint {
  const sem = POLICY_SEMANTICS[def.key];
  return {
    acciones: sem.acciones.length,
    recursos: sem.recursos.length,
    roles: policyRoles(def, params).length,
    apps: sem.apps.length,
  };
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
