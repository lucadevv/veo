'use client';

import Link from 'next/link';
import { ChevronRight, Circle, Lock, SlidersHorizontal, ToggleRight, Wrench } from 'lucide-react';
import { POLICY_LIST, type PolicyDef } from '@veo/policy';
import type { PolicyView } from '@/lib/api/schemas';
import {
  FAMILY_META,
  FAMILY_ORDER,
  isConfigurable,
  isNetNew,
  paramChipSummary,
  POLICY_ICONS,
} from '@/lib/gobierno';
import { useUpdatePolicy } from '@/lib/api/queries';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Switch } from '@/components/ui/switch';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { PolicyConfigDialog } from './policy-config-dialog';

/**
 * Grilla de las 16 políticas de gobierno agrupadas por familia (diseño AdminPoliticas). El ESTADO viene del
 * backend (`policies`, PolicyView[]); la metadata de forma (familia/label/mandatory/params) de @veo/policy. Cada
 * fila: ícono + título + key + switch de `enabled` (candado si `mandatory`) + chip de config (si tiene params).
 * El toggle y el guardado de params exigen step-up MFA (@RequireStepUpMfa del bff): la UI solo refleja, identity
 * re-valida. Las políticas NET-NEW llevan el badge "en desarrollo" (aún sin enforcement · ADR-024 §5).
 */
export function PoliciesPanel({
  policies,
  canManage,
}: {
  policies: PolicyView[];
  canManage: boolean;
}) {
  const byKey = new Map(policies.map((p) => [p.key, p]));

  return (
    <div className="flex flex-col gap-6 pt-4">
      <Legend />
      {FAMILY_ORDER.map((family) => {
        const defs = POLICY_LIST.filter((d) => d.family === family);
        const rows = defs
          .map((def) => ({ def, view: byKey.get(def.key) }))
          .filter((r): r is { def: PolicyDef; view: PolicyView } => r.view !== undefined);
        if (rows.length === 0) return null;
        const meta = FAMILY_META[family];
        const FamilyIcon = meta.icon;
        const activeCount = rows.filter((r) => r.view.enabled).length;
        return (
          <section
            key={family}
            className="overflow-hidden rounded-xl border border-border bg-surface"
          >
            <div className="flex items-center justify-between gap-4 border-b border-border bg-surface-2/50 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="grid size-9 place-items-center rounded-lg bg-surface-2 text-accent">
                  <FamilyIcon className="size-5" aria-hidden />
                </div>
                <div className="leading-tight">
                  <h2 className="text-sm font-semibold text-ink">{meta.label}</h2>
                  <p className="text-xs text-ink-subtle">{meta.hint}</p>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-border bg-bg px-3 py-1 text-xs text-ink-muted">
                {activeCount} de {rows.length} activas
              </span>
            </div>
            <ul>
              {rows.map(({ def, view }, i) => (
                <PolicyRow
                  key={def.key}
                  def={def}
                  view={view}
                  canManage={canManage}
                  last={i === rows.length - 1}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Legend() {
  const items = [
    { icon: ToggleRight, className: 'text-success', label: 'Activa' },
    { icon: Circle, className: 'text-ink-subtle', label: 'Inactiva' },
    { icon: Lock, className: 'text-warn', label: 'Obligatoria · Ley 29733' },
    { icon: SlidersHorizontal, className: 'text-accent', label: 'Configurable' },
    { icon: Wrench, className: 'text-ink-muted', label: 'Enforcement en desarrollo' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map(({ icon: Icon, className, label }) => (
        <span key={label} className="flex items-center gap-1.5 text-xs text-ink-muted">
          <Icon className={cn('size-3.5', className)} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  );
}

function PolicyRow({
  def,
  view,
  canManage,
  last,
}: {
  def: PolicyDef;
  view: PolicyView;
  canManage: boolean;
  last: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdatePolicy();
  const Icon = POLICY_ICONS[def.key] ?? Wrench;
  const netNew = isNetNew(def.key);
  const configurable = isConfigurable(def);
  const chip = configurable ? paramChipSummary(def, view.params) : null;
  const togglePending = update.isPending && update.variables?.key === def.key;

  async function toggle() {
    try {
      await update.mutateAsync({ key: def.key, enabled: !view.enabled });
      toast({
        tone: 'success',
        title: view.enabled ? 'Política desactivada' : 'Política activada',
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
    <li
      className={cn(
        'flex items-center gap-4 border-l-[3px] px-5 py-4',
        def.mandatory ? 'border-l-warn' : 'border-l-transparent',
        last ? '' : 'border-b border-b-border',
      )}
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-muted">
        <Icon className="size-5" aria-hidden />
      </div>

      {/* El bloque de identidad es un link al detalle drill-in (contenido no interactivo → link seguro). */}
      <Link
        href={`/gobierno/politicas/${def.key}`}
        className="group min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={`Ver detalle de ${def.label}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-ink transition-colors group-hover:text-accent">
            {def.label}
          </p>
          {netNew ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-inset ring-border">
              <Wrench className="size-3" aria-hidden />
              En desarrollo
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex items-center gap-2 font-mono text-xs text-ink-subtle">
          policy:{def.key}
        </p>
      </Link>

      {/* Chip de configuración: abre el editor genérico de params (solo si la política es configurable). */}
      {configurable ? (
        <PolicyConfigDialog
          def={def}
          policy={view}
          canManage={canManage}
          trigger={
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
            >
              <span className="font-mono">{chip ?? 'Configurar'}</span>
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          }
        />
      ) : null}

      {/* Control on/off: candado si es obligatoria (Ley 29733), si no un switch con step-up. */}
      {def.mandatory ? (
        <span
          className="grid size-6 shrink-0 place-items-center text-warn"
          title="Obligatoria (Ley 29733): no se puede desactivar"
        >
          <Lock className="size-4" aria-hidden />
        </span>
      ) : canManage ? (
        <StepUpDialog
          trigger={
            <Switch
              checked={view.enabled}
              disabled={togglePending}
              label={`${view.enabled ? 'Desactivar' : 'Activar'} ${def.label}`}
            />
          }
          title={view.enabled ? `Desactivar ${def.label}` : `Activar ${def.label}`}
          description={`Vas a ${view.enabled ? 'DESACTIVAR' : 'ACTIVAR'} la política ${def.key}. El cambio es global y queda auditado.`}
          onVerified={toggle}
        />
      ) : (
        <Switch checked={view.enabled} disabled label={`${def.label} (solo lectura)`} />
      )}
    </li>
  );
}
