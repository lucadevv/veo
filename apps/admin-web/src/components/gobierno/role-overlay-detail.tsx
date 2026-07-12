'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  CircleCheck,
  EyeOff,
  History,
  Lock,
  Minus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import type { AdminRole } from '@veo/shared-types';
import type { PermissionOverrideView } from '@/lib/api/schemas';
import { useSetPermissionOverride } from '@/lib/api/queries';
import {
  composeRoleOverlay,
  roleMeta,
  type PermissionStatus,
  type RolePermissionRow,
} from '@/lib/gobierno/permissions';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { StepUpDialog } from '@/components/security/step-up-dialog';

// Un <Link> con LOOK de botón (el `Button` del kit no soporta `asChild`/Slot, y anidar <button> en <a> es HTML
// inválido). Mismos tokens que `buttonVariants` (brand/ghost) para no divergir del look del kit sin hardcodear.
const LINK_BTN_BASE =
  'inline-flex h-9 w-full items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold ' +
  'transition-[transform,background-color,color,border-color] duration-150 ease-out active:scale-[0.97] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const LINK_BTN_VARIANT = {
  primary: 'bg-brand text-brand-on hover:bg-brand-hover',
  ghost: 'bg-transparent text-ink hover:bg-surface-2',
} as const;

/**
 * Gobierno → Permisos · DETALLE por rol (drill-in desde la matriz · ADR-025 §3). Proyecta el efectivo de UN rol
 * componiendo client-side `base ∧ ¬overlay` (la misma fórmula que enforcea identity y que la matriz aplica
 * por-celda), reusando `composeRoleOverlay` de `@/lib/gobierno/permissions`. NO agrega backend: lee el overlay de
 * `GET /gobierno/permission-overrides` y resta contra la base de `@veo/policy`.
 *
 * Acciones (seams EXISTENTES):
 *  • "Editar overlay" → navega a la matriz (`/gobierno/permisos`), el editor canónico (no se duplica).
 *  • "Restablecer al rol base" → loop del PUT existente (`useSetPermissionOverride`) que des-resta cada par oculto
 *    de ESTE rol; acción sensible → step-up MFA (StepUpDialog) + confirmación.
 *  • "Ver en auditoría" → deep-link `/audit?q={role}` (patrón `?q=` que el admin ya usa).
 */
export function RoleOverlayDetail({
  role,
  overrides,
}: {
  role: AdminRole;
  overrides: PermissionOverrideView[];
}) {
  const meta = roleMeta(role);
  const { toast } = useToast();
  const setOverride = useSetPermissionOverride();
  const [resetting, setResetting] = useState(false);

  const { modules, totals } = useMemo(() => composeRoleOverlay(role, overrides), [role, overrides]);

  /** Pares (rol, permiso) actualmente RESTADOS de este rol — lo que "Restablecer al rol base" des-resta. */
  const hiddenPermissions = useMemo(
    () => modules.flatMap((g) => g.rows).filter((r) => r.hidden).map((r) => r.permission),
    [modules],
  );

  async function resetToBase() {
    setResetting(true);
    try {
      // Un PUT hidden=false por par restado (identity re-valida subtract-only + candado en cada uno).
      for (const permission of hiddenPermissions) {
        await setOverride.mutateAsync({ role, permission, hidden: false });
      }
      toast({
        tone: 'success',
        title: 'Overlay restablecido',
        description: `${hiddenPermissions.length} ${
          hiddenPermissions.length === 1 ? 'permiso restaurado' : 'permisos restaurados'
        } a la base de ${meta?.label ?? role}.`,
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo restablecer el overlay',
        description: e instanceof Error ? e.message : undefined,
      });
      throw e;
    } finally {
      setResetting(false);
    }
  }

  const roleLabel = meta?.label ?? role;

  return (
    <div className="flex flex-col gap-5 pt-4">
      <Link
        href="/gobierno/permisos"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-md"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Volver a la matriz
      </Link>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* ── Columna principal ── */}
        <div className="flex flex-col gap-5">
          <EffectiveExplainer />

          <section className="rounded-xl border border-border bg-surface">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">Permisos por módulo</h2>
              <Badge tone={totals.hidden > 0 ? 'warn' : 'neutral'}>
                {totals.hidden} {totals.hidden === 1 ? 'oculto' : 'ocultos'}
              </Badge>
            </header>
            <div className="flex flex-col">
              {modules.map((group) => (
                <div key={group.resource} className="border-b border-border last:border-b-0">
                  <p className="bg-surface-2/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                    {group.label}
                  </p>
                  <ul>
                    {group.rows.map((row) => (
                      <li
                        key={row.permission}
                        className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 first:border-t-0"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm text-ink">{row.action}</span>
                          <span className="truncate font-mono text-xs text-ink-subtle">
                            {row.permission}
                          </span>
                        </span>
                        <StatusBadge status={row.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ── Columna lateral ── */}
        <aside className="flex flex-col gap-5">
          <section className="rounded-xl border border-border bg-surface px-4 py-4">
            <h2 className="text-sm font-semibold text-ink">Rol</h2>
            <dl className="mt-3 flex flex-col gap-2.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Nombre</dt>
                <dd className="font-medium text-ink">{roleLabel}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Código</dt>
                <dd className="font-mono text-xs text-ink">{role}</dd>
              </div>
              {meta ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-muted">Abreviatura</dt>
                  <dd className="font-medium text-ink">{meta.short}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink">Resumen del overlay</h2>
            <StatCardGrid className="grid-cols-3 gap-3 lg:grid-cols-3">
              <StatCard
                icon={ShieldCheck}
                iconTone="neutral"
                label="Base"
                value={String(totals.base)}
              />
              <StatCard
                icon={EyeOff}
                iconTone={totals.hidden > 0 ? 'warn' : 'neutral'}
                label="Ocultos"
                value={String(totals.hidden)}
              />
              <StatCard
                icon={CircleCheck}
                iconTone="success"
                label="Efectivos"
                value={String(totals.effective)}
              />
            </StatCardGrid>
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
            <p className="text-xs text-ink-muted">
              Editar el overlay exige autenticación step-up y queda registrado en auditoría. El overlay solo{' '}
              <span className="font-medium text-ink">RESTA</span>: nunca concede de más.
            </p>
            <Link
              href={`/gobierno/permisos?role=${role}`}
              className={cn(LINK_BTN_BASE, LINK_BTN_VARIANT.primary)}
            >
              <SlidersHorizontal className="size-4" aria-hidden />
              Editar overlay en la matriz
            </Link>

            <StepUpDialog
              trigger={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={totals.hidden === 0 || resetting}
                  loading={resetting}
                >
                  <RotateCcw className="size-4" aria-hidden />
                  Restablecer al rol base
                </Button>
              }
              title={`Restablecer ${roleLabel} a la base`}
              description={`Vas a des-restar ${totals.hidden} ${
                totals.hidden === 1 ? 'permiso oculto' : 'permisos ocultos'
              } del overlay de este rol. El rol vuelve a su matriz BASE y el cambio queda auditado.`}
              confirmLabel="Restablecer"
              onVerified={resetToBase}
            />

            <Link href={`/audit?q=${role}`} className={cn(LINK_BTN_BASE, LINK_BTN_VARIANT.ghost)}>
              <History className="size-4" aria-hidden />
              Ver en auditoría
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Explainer del efectivo: `base ∧ ¬overlay`, con las píldoras de la fórmula. */
function EffectiveExplainer() {
  return (
    <section className="rounded-xl border border-border bg-surface px-4 py-4">
      <h2 className="text-sm font-semibold text-ink">Cómo se calcula el permiso efectivo</h2>
      <p className="mt-1.5 text-sm text-ink-muted">
        El overlay solo puede <span className="font-medium text-ink">QUITAR</span> permisos del rol base — nunca
        agregar. El permiso efectivo es la base menos los overrides ocultos.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Base</Badge>
        <span className="font-mono text-sm text-ink-subtle" aria-hidden>
          ∧ ¬
        </span>
        <Badge tone="warn">Overlay</Badge>
        <span className="font-mono text-sm text-ink-subtle" aria-hidden>
          =
        </span>
        <Badge tone="success">Efectivo</Badge>
      </div>
    </section>
  );
}

const STATUS_BADGE: Record<
  PermissionStatus,
  { tone: React.ComponentProps<typeof Badge>['tone']; icon: typeof Check; label: string }
> = {
  visible: { tone: 'success', icon: Check, label: 'Visible' },
  hidden: { tone: 'warn', icon: EyeOff, label: 'Oculto por overlay' },
  legal: { tone: 'neutral', icon: Lock, label: 'Candado legal' },
  na: { tone: 'neutral', icon: Minus, label: 'No aplica' },
};

/** Píldora de estado del permiso (Visible · Oculto por overlay · Candado legal · No aplica). */
function StatusBadge({ status }: { status: RolePermissionRow['status'] }) {
  const { tone, icon: Icon, label } = STATUS_BADGE[status];
  return (
    <Badge tone={tone} className={cn('shrink-0', status === 'na' && 'text-ink-subtle')}>
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}
