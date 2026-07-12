'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Lock, Wrench } from 'lucide-react';
import { POLICY_LIST, type PolicyDef, type PolicyFamily } from '@veo/policy';
import type { PolicyView } from '@/lib/api/schemas';
import { FAMILY_ORDER, isConfigurable, isNetNew, paramChipSummary, POLICY_ICONS } from '@/lib/gobierno';
import { useUpdatePolicy } from '@/lib/api/queries';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Switch } from '@/components/ui/switch';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { PolicyConfigDialog } from './policy-config-dialog';

/**
 * Registro de las 16 políticas de gobierno (board `23 · Políticas`): lista PLANA en una card, con chips de filtro
 * por familia arriba y un tinte de familia por fila (ícono + pill de categoría). El ESTADO viene del backend
 * (`policies`); la forma (familia/label/mandatory/params) de @veo/policy. Cada fila: ícono tintado + nombre + key +
 * chip de config (si tiene params) + pill de familia + switch de `enabled` (candado si `mandatory`). El toggle y el
 * guardado de params exigen step-up MFA (@RequireStepUpMfa del bff): la UI refleja, identity re-valida. Las NET-NEW
 * llevan el badge "En desarrollo" (aún sin enforcement · ADR-024 §5) — el board no lo muestra, pero es honesto.
 */

/**
 * Tono por familia (SOLO tokens del theme — la var del token, sin hex crudo). Da el color de scanneo del board.
 * Se aplica por `style` con `var(--token)` + `color-mix` (no clases Tailwind de opacidad): `--info` se agregó al
 * config y el JIT no lo regenera sin reiniciar, y las utilidades `bg-x/NN` son frágiles acá. La var siempre resuelve.
 */
const FAMILY_TONE: Record<PolicyFamily, { short: string; token: string }> = {
  data: { short: 'Datos', token: '--info' },
  auth: { short: 'Auth', token: '--warn' },
  access: { short: 'Acceso', token: '--brand' },
  ops: { short: 'Operativas', token: '--success' },
};

/** Estilo de tinte (texto = token, fondo = token al 12%) desde la var del theme — JIT-independiente. */
function tintStyle(token: string): React.CSSProperties {
  return { color: `var(${token})`, backgroundColor: `color-mix(in oklab, var(${token}) 12%, transparent)` };
}

export function PoliciesPanel({
  policies,
  canManage,
}: {
  policies: PolicyView[];
  canManage: boolean;
}) {
  const [filter, setFilter] = useState<PolicyFamily | 'all'>('all');
  const byKey = new Map(policies.map((p) => [p.key, p]));

  // Lista PLANA en orden canónico del catálogo, con el estado del backend; filtrada por la familia elegida.
  const rows = POLICY_LIST.map((def) => ({ def, view: byKey.get(def.key) }))
    .filter((r): r is { def: PolicyDef; view: PolicyView } => r.view !== undefined)
    .filter((r) => filter === 'all' || r.def.family === filter);

  return (
    <div className="flex flex-col gap-4 pt-4">
      {/* Filtro por familia — chips (board): "Todas" + las 4 familias reales. Filtra client-side. */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          Todas
        </FilterChip>
        {FAMILY_ORDER.map((family) => (
          <FilterChip key={family} active={filter === family} onClick={() => setFilter(family)}>
            {FAMILY_TONE[family].short}
          </FilterChip>
        ))}
      </div>

      <ul className="overflow-hidden rounded-2xl border border-black/[0.05] bg-surface shadow-3">
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
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // Activo: fondo brand + texto on-brand (blanco) por `style` con las vars del theme — `text-on-brand` no lo
      // regenera el JIT acá (mismo caso que los tintes), así el contraste del chip seleccionado nunca falla.
      style={active ? { backgroundColor: 'var(--brand)', color: 'var(--on-brand)', borderColor: 'var(--brand)' } : undefined}
      className={cn(
        'rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors',
        active ? '' : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      {children}
    </button>
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
  const tone = FAMILY_TONE[def.family];
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
        'flex items-center gap-3.5 px-[22px] py-[15px]',
        last ? '' : 'border-b border-b-[color:var(--divider)]',
      )}
    >
      {/* Ícono con tinte de familia (el pop de color del board). */}
      <div
        className="grid size-10 shrink-0 place-items-center rounded-[11px]"
        style={tintStyle(tone.token)}
      >
        <Icon className="size-5" aria-hidden />
      </div>

      {/* Identidad (link al detalle drill-in). */}
      <Link
        href={`/gobierno/politicas/${def.key}`}
        className="group min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        aria-label={`Ver detalle de ${def.label}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-ink transition-colors group-hover:text-brand">
            {def.label}
          </p>
          {netNew ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-inset ring-border">
              <Wrench className="size-3" aria-hidden />
              En desarrollo
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 font-mono text-xs text-ink-subtle">policy:{def.key}</p>
      </Link>

      {/* Chip de config: abre el editor genérico de params (solo si es configurable). */}
      {configurable ? (
        <PolicyConfigDialog
          def={def}
          policy={view}
          canManage={canManage}
          trigger={
            <button
              type="button"
              className="hidden shrink-0 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-border-strong hover:text-ink sm:inline-flex"
            >
              <span className="font-mono">{chip ?? 'Configurar'}</span>
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          }
        />
      ) : null}

      {/* Pill de familia (categoría) — el tag de color del board. */}
      <span
        className="hidden shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold md:inline-flex"
        style={tintStyle(tone.token)}
      >
        {tone.short}
      </span>

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
