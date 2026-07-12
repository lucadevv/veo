'use client';

import Link from 'next/link';
import {
  ArrowDown,
  ArrowLeft,
  Lock,
  Power,
  RefreshCw,
  ScrollText,
  Settings2,
  Wrench,
} from 'lucide-react';
import { getPolicyDef, isPolicyKey, type PolicyKey } from '@veo/policy';
import { ApiError, type PolicyView, type PolicyVersionView } from '@/lib/api/schemas';
import {
  derivePolicyRule,
  derivePolicyScope,
  FAMILY_META,
  isConfigurable,
  isNetNew,
  paramChipSummary,
  POLICY_ICONS,
  type DerivedScope,
  type RuleClause,
} from '@/lib/gobierno';
import { roleMeta } from '@/lib/gobierno/permissions';
import { usePolicy, usePolicyHistory, useUpdatePolicy } from '@/lib/api/queries';
import { date } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { PolicyConfigDialog } from './policy-config-dialog';

/** Un <Link> con LOOK de botón (el `Button` del kit no soporta `asChild`). Mismos tokens que el kit (LINK_BTN). */
const LINK_BTN_BASE =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-control text-sm font-semibold ' +
  'transition-[transform,background-color,color,border-color] duration-150 ease-out active:scale-[0.97] ' +
  'focus-visible:outline-none';
const LINK_BTN_VARIANT = {
  secondary: 'bg-surface-2 text-ink border border-border hover:border-border-strong',
} as const;

/**
 * Detalle de UNA política de gobierno (drill-in del board `jznes` "Políticas · Detalle"). Anatomía espejo del
 * detalle de oferta (`offering-detail-view`): topbar (back + breadcrumb + estado) + grid 1fr/360 con cards.
 *
 * HONESTIDAD de datos (ver reporte):
 *  • Regla (WHEN/THEN) y Alcance → DERIVADOS de key + `params` vigentes (`derivePolicyRule`/`derivePolicyScope`).
 *    Presentación de la config existente, no backend nuevo.
 *  • Historial → backend REAL nuevo (tabla `PolicyVersion` de identity). `[]` = sin cambios aún (arranca vacío).
 *  • Impacto → SOLO stats con fuente real: Versión (view.version), Cambios (history.length), Alcance (nº de roles /
 *    rangos, o "Global"). Los "Endpoints" y "App" del board se OMITEN (sin fuente que los compute).
 */
export function PolicyDetailView({
  policyKey,
  canManage,
}: {
  policyKey: string;
  canManage: boolean;
}) {
  const valid = isPolicyKey(policyKey);
  const query = usePolicy(valid ? policyKey : '');
  const historyQuery = usePolicyHistory(valid ? policyKey : '');

  // 404 client-side: una key que no existe en el catálogo ni siquiera se consulta.
  if (!valid) {
    return (
      <div className="flex h-full flex-col">
        <Topbar title="Política" />
        <NotFound />
      </div>
    );
  }

  const def = getPolicyDef(policyKey as PolicyKey);

  // 404 server-side: key válida pero sin fila seedeada → NotFound honesto (no un error genérico).
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div className="flex h-full flex-col">
      <Topbar title={def.label} policy={query.data} />
      {query.isLoading ? (
        <DetailSkeleton />
      ) : isNotFound ? (
        <NotFound />
      ) : query.isError || !query.data ? (
        <ErrorState className="m-7" onRetry={() => void query.refetch()} />
      ) : (
        <Loaded
          policy={query.data}
          canManage={canManage}
          history={historyQuery.data}
          historyLoading={historyQuery.isLoading}
          historyError={historyQuery.isError}
          onRetryHistory={() => void historyQuery.refetch()}
        />
      )}
    </div>
  );
}

/* ── Topbar: back (→ /gobierno/politicas) + breadcrumb + título + estado ── */
function Topbar({ title, policy }: { title: string; policy?: PolicyView }) {
  return (
    <header className="sticky top-0 z-sticky flex items-center justify-between gap-4 border-b border-[color:var(--divider)] bg-surface px-7 py-4">
      <div className="flex items-center gap-3.5">
        <Link
          href="/gobierno/politicas"
          aria-label="Volver a Políticas"
          className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-border bg-bg text-ink-muted transition-colors hover:bg-surface-2"
        >
          <ArrowLeft className="size-[17px]" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <span>Gobierno</span>
            <span>/</span>
            <Link href="/gobierno/politicas" className="transition-colors hover:text-ink-muted">
              Políticas
            </Link>
          </div>
          <h1 className="truncate font-display text-[21px] font-bold tracking-[-0.4px] text-ink">
            {title}
          </h1>
        </div>
      </div>
      {policy ? <StatusBadge enabled={policy.enabled} /> : null}
    </header>
  );
}

/** Badge de estado: Activa (jade) / Inactiva (gris). Fiel al pill verde del board. */
function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
        enabled ? 'bg-success/12 text-success' : 'bg-surface-2 text-ink-muted',
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', enabled ? 'bg-success' : 'bg-ink-subtle')}
        aria-hidden
      />
      {enabled ? 'Activa' : 'Inactiva'}
    </span>
  );
}

function NotFound() {
  return (
    <EmptyState
      className="m-7"
      icon={<Wrench className="size-6" aria-hidden />}
      title="Política no encontrada"
      description="Esta política no existe en el registro de gobierno. Volvé al listado de políticas."
    />
  );
}

/* ── Contenido cargado ── */
function Loaded({
  policy,
  canManage,
  history,
  historyLoading,
  historyError,
  onRetryHistory,
}: {
  policy: PolicyView;
  canManage: boolean;
  history: PolicyVersionView[] | undefined;
  historyLoading: boolean;
  historyError: boolean;
  onRetryHistory: () => void;
}) {
  const def = getPolicyDef(policy.key as PolicyKey);
  const rule = derivePolicyRule(def, policy.params);
  const scope = derivePolicyScope(def, policy.params);

  return (
    <div className="grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_360px] lg:items-start">
      {/* Izquierda: Regla + Alcance + Historial */}
      <div className="flex flex-col gap-[18px]">
        <RuleCard rule={rule} />
        <ScopeCard def={def} scope={scope} />
        <HistoryCard
          def={def}
          history={history}
          loading={historyLoading}
          error={historyError}
          onRetry={onRetryHistory}
        />
      </div>
      {/* Derecha: Política + Impacto + Acciones */}
      <div className="flex flex-col gap-[18px]">
        <MetaCard def={def} policy={policy} />
        <ImpactCard scope={scope} version={policy.version} changes={history?.length ?? 0} />
        <ActionsCard def={def} policy={policy} canManage={canManage} />
      </div>
    </div>
  );
}

/* ── Card estándar (mismos tokens que offering-detail: surface, radius 20, padding 22, título 16/700) ── */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[14px] rounded-[20px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <h2 className="font-display text-base font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/* ── Regla (PBAC): bloque CUANDO (accent) ▸ flecha ▸ bloque ENTONCES (success) ── */
function RuleCard({ rule }: { rule: { when: RuleClause[]; then: RuleClause[] } }) {
  return (
    <Card title="Regla (PBAC)">
      <RuleBlock label="CUANDO (condición)" tone="accent" clauses={rule.when} />
      <div className="flex justify-center py-0.5">
        <ArrowDown className="size-[18px] text-ink-subtle" aria-hidden />
      </div>
      <RuleBlock label="ENTONCES (efecto)" tone="success" clauses={rule.then} />
    </Card>
  );
}

function RuleBlock({
  label,
  tone,
  clauses,
}: {
  label: string;
  tone: 'accent' | 'success';
  clauses: RuleClause[];
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface-2 p-4">
      <p
        className={cn(
          'text-[11px] font-bold uppercase tracking-[0.06em]',
          tone === 'accent' ? 'text-accent' : 'text-success',
        )}
      >
        {label}
      </p>
      {clauses.map((c) => (
        <div key={c.term} className="flex items-center gap-2.5">
          <span className="w-[104px] shrink-0 font-mono text-xs text-ink-subtle">{c.term}</span>
          <span
            className={cn(
              'inline-flex rounded-lg px-2.5 py-1.5 font-mono text-xs font-semibold',
              tone === 'accent' ? 'bg-accent/10 text-accent' : 'bg-success/12 text-success',
            )}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Alcance: roles / rangos CIDR targeteados, o "Global" ── */
function ScopeCard({ def, scope }: { def: ReturnType<typeof getPolicyDef>; scope: DerivedScope }) {
  return (
    <Card title="Alcance">
      {scope.kind === 'global' ? (
        <ScopeRow
          label="Alcance"
          chips={['Todos los roles · global']}
          empty="—"
        />
      ) : scope.kind === 'roles' ? (
        <ScopeRow
          label="Roles alcanzados"
          chips={scope.roles.map((r) => roleMeta(r)?.label ?? r)}
          empty="Ningún rol — la política no habilita a nadie"
        />
      ) : (
        <ScopeRow
          label="Rangos IP (CIDR)"
          chips={scope.cidrs}
          empty="Lista vacía — sin restricción de IP"
        />
      )}
      <p className="text-xs leading-relaxed text-ink-muted">{def.description}</p>
    </Card>
  );
}

function ScopeRow({ label, chips, empty }: { label: string; chips: string[]; empty: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-[130px] shrink-0 text-[13px] text-ink-muted">{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {chips.length > 0 ? (
          chips.map((c) => (
            <span
              key={c}
              className="inline-flex rounded-full border border-border bg-surface-2 px-2.5 py-1 font-mono text-xs font-semibold text-ink"
            >
              {c}
            </span>
          ))
        ) : (
          <span className="text-xs text-ink-subtle">{empty}</span>
        )}
      </div>
    </div>
  );
}

/* ── Historial de cambios: timeline REAL (tabla PolicyVersion). Vacío = "sin cambios aún" (honesto) ── */
function HistoryCard({
  def,
  history,
  loading,
  error,
  onRetry,
}: {
  def: ReturnType<typeof getPolicyDef>;
  history: PolicyVersionView[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <Card title="Historial de cambios">
      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Cargando historial">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-muted">No se pudo cargar el historial de cambios.</p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden /> Reintentar
          </Button>
        </div>
      ) : !history || history.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Sin cambios registrados aún. El historial arranca vacío y se acumula desde la primera
          edición de esta política.
        </p>
      ) : (
        <ol className="flex flex-col">
          {history.map((entry, i) => (
            <TimelineRow
              key={entry.version}
              def={def}
              entry={entry}
              latest={i === 0}
              last={i === history.length - 1}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function TimelineRow({
  def,
  entry,
  latest,
  last,
}: {
  def: ReturnType<typeof getPolicyDef>;
  entry: PolicyVersionView;
  latest: boolean;
  last: boolean;
}) {
  const summary = isConfigurable(def) ? paramChipSummary(def, entry.params) : null;
  const actor = entry.changedBy === 'system' ? 'Sistema' : entry.changedBy;
  return (
    <li className="flex items-start gap-3.5">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span
          className={cn(
            'size-7 shrink-0 rounded-full',
            latest ? 'bg-accent' : 'bg-success',
          )}
          aria-hidden
        />
        {!last ? <span className="h-[30px] w-[2.5px] bg-success" aria-hidden /> : null}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 pb-5 pt-0.5">
        <p className="text-[15px] font-medium text-ink">
          v{entry.version} · {entry.enabled ? 'Activa' : 'Inactiva'}
          {summary ? ` · ${summary}` : ''}
        </p>
        <p className="font-mono text-xs text-ink-subtle">
          {date(entry.changedAt)} · <span className="truncate">{actor}</span>
        </p>
      </div>
    </li>
  );
}

/* ── Card Política: metadatos (ID, categoría, estado, versión, modificación) ── */
function MetaCard({
  def,
  policy,
}: {
  def: ReturnType<typeof getPolicyDef>;
  policy: PolicyView;
}) {
  const netNew = isNetNew(policy.key as PolicyKey);
  return (
    <Card title="Política">
      <div className="flex flex-col gap-3">
        <MetaRow label="ID" value={<span className="font-mono text-sm text-ink">{policy.key}</span>} />
        <MetaRow
          label="Categoría"
          value={
            <span className="inline-flex rounded-full bg-accent/10 px-2.5 py-1 text-xs font-bold text-accent">
              {FAMILY_META[def.family].label}
            </span>
          }
        />
        <MetaRow label="Estado" value={<StatusBadge enabled={policy.enabled} />} />
        <MetaRow label="Versión" value={<span className="font-mono text-sm font-semibold text-ink">v{policy.version}</span>} />
        <MetaRow
          label="Modificación"
          value={
            <span className="inline-flex rounded-full bg-warn/15 px-2.5 py-1 text-xs font-bold text-warn">
              Requiere step-up
            </span>
          }
        />
        {policy.mandatory ? (
          <MetaRow
            label="Candado legal"
            value={
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn">
                <Lock className="size-3.5" aria-hidden /> Ley 29733
              </span>
            }
          />
        ) : null}
        {netNew ? (
          <MetaRow
            label="Enforcement"
            value={
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                <Wrench className="size-3.5" aria-hidden /> En desarrollo
              </span>
            }
          />
        ) : null}
      </div>
    </Card>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-ink-muted">{label}</span>
      {value}
    </div>
  );
}

/* ── Impacto: SOLO stats con fuente real. Endpoints/App del board OMITIDOS (sin fuente). ── */
function ImpactCard({
  scope,
  version,
  changes,
}: {
  scope: DerivedScope;
  version: number;
  changes: number;
}) {
  const scopeStat =
    scope.kind === 'roles'
      ? { value: String(scope.roles.length), label: scope.roles.length === 1 ? 'Rol' : 'Roles' }
      : scope.kind === 'cidrs'
        ? { value: String(scope.cidrs.length), label: scope.cidrs.length === 1 ? 'Rango IP' : 'Rangos IP' }
        : { value: 'Global', label: 'Alcance' };
  return (
    <Card title="Impacto">
      <div className="grid grid-cols-3 gap-3">
        <Stat value={`v${version}`} label="Versión" />
        <Stat value={String(changes)} label={changes === 1 ? 'Cambio' : 'Cambios'} />
        <Stat value={scopeStat.value} label={scopeStat.label} />
      </div>
    </Card>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-[14px] border border-border bg-surface-2 p-3.5">
      <p className="font-display text-2xl font-bold text-ink">{value}</p>
      <p className="text-center text-[11px] text-ink-subtle">{label}</p>
    </div>
  );
}

/* ── Acciones: Editar (config, step-up) · Ver auditoría (deep-link) · Desactivar/Activar (toggle, step-up) ── */
function ActionsCard({
  def,
  policy,
  canManage,
}: {
  def: ReturnType<typeof getPolicyDef>;
  policy: PolicyView;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdatePolicy();
  const configurable = isConfigurable(def);

  async function toggle() {
    try {
      await update.mutateAsync({ key: def.key, enabled: !policy.enabled });
      toast({
        tone: 'success',
        title: policy.enabled ? 'Política desactivada' : 'Política activada',
        description: def.label,
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo cambiar la política',
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Editar los parámetros (solo si la política es configurable) — reusa el editor genérico + step-up. */}
      {configurable && canManage ? (
        <PolicyConfigDialog
          def={def}
          policy={policy}
          canManage={canManage}
          trigger={
            <Button variant="primary" className="w-full">
              <Settings2 className="size-4" aria-hidden /> Editar política · step-up
            </Button>
          }
        />
      ) : null}

      {/* Ver auditoría — deep-link al libro (filtra por la key de la política). */}
      <Link
        href={`/audit?q=policy:${encodeURIComponent(def.key)}`}
        className={cn(LINK_BTN_BASE, LINK_BTN_VARIANT.secondary)}
      >
        <ScrollText className="size-4" aria-hidden /> Ver en auditoría
      </Link>

      {/* Desactivar / Activar — el candado legal (mandatory) NO se puede desactivar. */}
      {def.mandatory ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <Lock className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p className="text-xs text-warn">
            Candado de la Ley 29733: esta política no se puede desactivar. Solo sus parámetros son
            configurables.
          </p>
        </div>
      ) : canManage ? (
        <StepUpDialog
          title={policy.enabled ? `Desactivar ${def.label}` : `Activar ${def.label}`}
          description={`Vas a ${policy.enabled ? 'DESACTIVAR' : 'ACTIVAR'} la política ${def.key}. El cambio es global y queda auditado.`}
          confirmLabel={policy.enabled ? 'Desactivar' : 'Activar'}
          confirmVariant={policy.enabled ? 'danger' : 'primary'}
          onVerified={toggle}
          trigger={
            <Button
              variant={policy.enabled ? 'danger' : 'primary'}
              className={cn('w-full', policy.enabled && 'border border-danger bg-transparent text-danger hover:bg-danger/5')}
              loading={update.isPending}
            >
              <Power className="size-4" aria-hidden />
              {policy.enabled ? 'Desactivar política' : 'Activar política'}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/* ── Skeleton (misma grilla que el contenido) ── */
function DetailSkeleton() {
  return (
    <div className="grid flex-1 gap-5 overflow-y-auto p-7 lg:grid-cols-[1fr_360px] lg:items-start">
      <div className="flex flex-col gap-[18px]">
        <Skeleton className="h-[320px] rounded-[20px]" />
        <Skeleton className="h-[180px] rounded-[20px]" />
        <Skeleton className="h-[200px] rounded-[20px]" />
      </div>
      <div className="flex flex-col gap-[18px]">
        <Skeleton className="h-[240px] rounded-[20px]" />
        <Skeleton className="h-[130px] rounded-[20px]" />
        <Skeleton className="h-[140px] rounded-[20px]" />
      </div>
    </div>
  );
}
