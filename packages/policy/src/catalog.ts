/**
 * Catálogo canónico de las 16 políticas PBAC (ADR-024 §5).
 *
 * Fuente ÚNICA de la forma (Zod), el default fail-safe, el flag `mandatory` (candado Ley 29733) y el
 * texto de UI de cada política. La tabla `Policy` de identity-service guarda el ESTADO VIGENTE; este
 * catálogo guarda el CONTRATO (schema + default) que valida ese estado y que la UI de config consume
 * (evita la deriva UI↔backend que menciona el ADR §9).
 *
 * ── Decisiones de forma (documentadas, ADR §5 no fija el shape exacto de todas) ────────────────────
 *  • `defaultEnabled`: refleja el «comportamiento seguro de HOY» (ADR §4). Las 7 HARDCODED y las
 *    mandatory arrancan `true` (ya se enforcean). Las NET-NEW (enforcement de cero) arrancan `false`:
 *    hoy NO existen, así que el fail-safe base = no operan todavía. `DefaultPolicyReader` devuelve este
 *    valor; cuando Fase 1/2 cableen el enforcement real, el superadmin las prende desde el registro.
 *  • Políticas sin parámetro numérico (`auth.mfa`, `auth.daily-reauth`, `access.least-privilege`,
 *    `ops.third-party-share`): schema `z.object({})` (strict) y `defaults {}` — son flags puros
 *    (on/off vía `enabled`), no tienen perillas. Honesto y validable.
 *  • `pii.mask`: el ADR habla de «sets de roles (const) · dniTail:4». Se modela `dniTail` (nº de dígitos
 *    visibles del DNI) + `revealRoles` (roles que ven PII sin enmascarar). Default de roles = los
 *    capaces de compliance hoy; se afina al cablear el enforcement real en Fase 1.
 *  • `access.ip-allowlist` default `cidrs:[]`: lista vacía = SIN restricción (no bloquea a nadie) →
 *    coherente con «hoy no existe» y con fail-safe (no se auto-cierra el acceso del superadmin).
 *  • `ops.export` / `ops.bulk-download`: `allowedRoles:[]` = nadie habilitado por default (NET-NEW,
 *    no hay endpoints aún) — fail-safe restrictivo para operaciones de datos en volumen.
 */
import { z } from 'zod';
import type { PolicyFamily, PolicyKey } from './keys.js';
import { POLICY_KEYS } from './keys.js';

/** Params de una política: objeto jsonb tipado por su schema Zod. */
export type PolicyParams = Record<string, unknown>;

/** Definición canónica de una política (una entrada del catálogo). */
export interface PolicyDef {
  /** Key canónica (id de la fila `Policy`). */
  readonly key: PolicyKey;
  /** Familia funcional. */
  readonly family: PolicyFamily;
  /** Candado Ley 29733: si `true`, `enabled` no puede ponerse en `false` (ADR §3). */
  readonly mandatory: boolean;
  /** Estado `enabled` por default = comportamiento seguro de hoy (ADR §4). */
  readonly defaultEnabled: boolean;
  /** Etiqueta corta para la UI (español). */
  readonly label: string;
  /** Descripción para la UI (español). */
  readonly description: string;
  /** Schema Zod de `params` — valida el jsonb por política (ADR §3). */
  readonly paramsSchema: z.ZodTypeAny;
  /** Valores por default de `params` (deben validar contra `paramsSchema`). */
  readonly defaults: PolicyParams;
}

/** Schema vacío estricto para políticas-flag (sin perillas). */
const NO_PARAMS = z.object({}).strict();

const ENTRIES: Record<PolicyKey, PolicyDef> = {
  'media.dual-auth': {
    key: 'media.dual-auth',
    family: 'data',
    mandatory: false,
    defaultEnabled: true,
    label: 'Doble autorización de video',
    description:
      'Acceder a la grabación de un viaje exige N aprobadores distintos (four-eyes por identidad+rol). Hoy N=2 implícito.',
    paramsSchema: z.object({ approvers: z.number().int().min(2) }).strict(),
    defaults: { approvers: 2 },
  },
  'pii.mask': {
    key: 'pii.mask',
    family: 'data',
    mandatory: true,
    defaultEnabled: true,
    label: 'Enmascarado de PII',
    description:
      'El DNI y datos personales se muestran enmascarados salvo a roles autorizados. Candado legal: no desactivable.',
    paramsSchema: z
      .object({
        dniTail: z.number().int().min(1).max(8),
        revealRoles: z.array(z.string().min(1)),
      })
      .strict(),
    defaults: { dniTail: 4, revealRoles: ['COMPLIANCE', 'SUPERADMIN'] },
  },
  'pii.reveal-stepup': {
    key: 'pii.reveal-stepup',
    family: 'data',
    mandatory: false,
    defaultEnabled: false,
    label: 'Step-up para revelar PII',
    description:
      'Revelar el DNI/PII completo exige MFA fresca dentro de una ventana. NET-NEW: hoy revelar es solo RBAC.',
    paramsSchema: z.object({ maxAgeSec: z.number().int().min(0) }).strict(),
    defaults: { maxAgeSec: 600 },
  },
  'media.retention': {
    key: 'media.retention',
    family: 'data',
    mandatory: false,
    defaultEnabled: true,
    label: 'Retención de video',
    description:
      'Días que se conserva la grabación antes del barrido. Default real del código = 30 (el .pen dice 90; se alinea en Fase 1).',
    paramsSchema: z.object({ days: z.number().int().min(1) }).strict(),
    defaults: { days: 30 },
  },
  'privacy.erasure': {
    key: 'privacy.erasure',
    family: 'data',
    mandatory: true,
    defaultEnabled: true,
    label: 'Derecho al olvido',
    description:
      'Días de gracia antes de ejecutar el borrado definitivo de una cuenta (Ley 29733). Candado legal: no desactivable.',
    paramsSchema: z.object({ graceDays: z.number().int().min(0) }).strict(),
    defaults: { graceDays: 30 },
  },
  'auth.mfa': {
    key: 'auth.mfa',
    family: 'auth',
    mandatory: true,
    defaultEnabled: true,
    label: 'MFA obligatorio',
    description:
      'Todo operador admin exige segundo factor en el login. Always-on, sin perillas. Candado legal.',
    paramsSchema: NO_PARAMS,
    defaults: {},
  },
  'auth.stepup': {
    key: 'auth.stepup',
    family: 'auth',
    mandatory: false,
    defaultEnabled: true,
    label: 'Step-up MFA para acciones sensibles',
    description:
      'Acciones sensibles exigen MFA fresca dentro de una ventana. Default real = 300s (coincide con el .pen).',
    paramsSchema: z.object({ maxAgeSec: z.number().int().min(0) }).strict(),
    defaults: { maxAgeSec: 300 },
  },
  'auth.session-timeout': {
    key: 'auth.session-timeout',
    family: 'auth',
    mandatory: false,
    defaultEnabled: false,
    label: 'Timeout por inactividad',
    description:
      'Cierra la sesión admin tras N minutos de inactividad. NET-NEW: hoy solo hay TTL duro de 15m, sin idle.',
    paramsSchema: z.object({ idleMin: z.number().int().min(1) }).strict(),
    defaults: { idleMin: 30 },
  },
  'auth.daily-reauth': {
    key: 'auth.daily-reauth',
    family: 'auth',
    mandatory: false,
    defaultEnabled: false,
    label: 'Re-autenticación diaria',
    description:
      'Fuerza re-autenticación completa una vez por día. NET-NEW: no existe hoy. Flag puro (on/off).',
    paramsSchema: NO_PARAMS,
    defaults: {},
  },
  'access.jit': {
    key: 'access.jit',
    family: 'access',
    mandatory: false,
    defaultEnabled: false,
    label: 'Acceso just-in-time',
    description:
      'Los grants de acceso elevado expiran tras N horas. NET-NEW: hoy no hay grants con expiración.',
    paramsSchema: z.object({ ttlHours: z.number().int().min(1) }).strict(),
    defaults: { ttlHours: 8 },
  },
  'access.ip-allowlist': {
    key: 'access.ip-allowlist',
    family: 'access',
    mandatory: false,
    defaultEnabled: false,
    label: 'Lista blanca de IPs',
    description:
      'Restringe el acceso admin a rangos CIDR autorizados. NET-NEW: requiere un IpAllowlistGuard nuevo. Lista vacía = sin restricción.',
    paramsSchema: z.object({ cidrs: z.array(z.string().min(1)) }).strict(),
    defaults: { cidrs: [] },
  },
  'access.review': {
    key: 'access.review',
    family: 'access',
    mandatory: false,
    defaultEnabled: false,
    label: 'Recertificación de accesos',
    description:
      'Recertificación periódica de accesos cada N días. NET-NEW: hoy no hay recertificación.',
    paramsSchema: z.object({ periodDays: z.number().int().min(1) }).strict(),
    defaults: { periodDays: 90 },
  },
  'access.least-privilege': {
    key: 'access.least-privilege',
    family: 'access',
    mandatory: false,
    defaultEnabled: true,
    label: 'Mínimo privilegio',
    description:
      'Los roles solo ven/hacen lo estrictamente necesario (RBAC + redacción default-null). Matriz AdminRole. Flag puro.',
    paramsSchema: NO_PARAMS,
    defaults: {},
  },
  'ops.export': {
    key: 'ops.export',
    family: 'ops',
    mandatory: false,
    defaultEnabled: false,
    label: 'Exportación de datos',
    description:
      'Exportar datasets solo por roles habilitados. NET-NEW: hoy no hay endpoints de export. Vacío = nadie habilitado.',
    paramsSchema: z.object({ allowedRoles: z.array(z.string().min(1)) }).strict(),
    defaults: { allowedRoles: [] },
  },
  'ops.third-party-share': {
    key: 'ops.third-party-share',
    family: 'ops',
    mandatory: false,
    defaultEnabled: true,
    label: 'Compartir con terceros',
    description:
      'Compartir datos con terceros (share-service). Es feature de producto, no enforcement de política. Flag puro.',
    paramsSchema: NO_PARAMS,
    defaults: {},
  },
  'ops.bulk-download': {
    key: 'ops.bulk-download',
    family: 'ops',
    mandatory: false,
    defaultEnabled: false,
    label: 'Descarga masiva',
    description:
      'Descarga masiva de datos solo por roles habilitados. NET-NEW: no existe hoy. Vacío = nadie habilitado.',
    paramsSchema: z.object({ allowedRoles: z.array(z.string().min(1)) }).strict(),
    defaults: { allowedRoles: [] },
  },
};

/**
 * Catálogo inmutable de las 16 políticas, indexado por key.
 * `satisfies` garantiza en compile-time que están TODAS las keys y solo esas.
 */
export const POLICY_CATALOG = ENTRIES satisfies Record<PolicyKey, PolicyDef>;

/** Lista de definiciones en el orden canónico del ADR (útil para render de la grilla). */
export const POLICY_LIST: readonly PolicyDef[] = POLICY_KEYS.map((k) => ENTRIES[k]);
