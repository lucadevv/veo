'use client';

import { Fragment, useMemo, useState } from 'react';
import { Lock, Minus } from 'lucide-react';
import { AdminRole } from '@veo/shared-types';
import {
  PERMISSION_LIST,
  baseGrants,
  isLegalMandatoryPermission,
  type Permission,
} from '@veo/policy';
import type { PermissionOverrideView } from '@/lib/api/schemas';
import { useSetPermissionOverride } from '@/lib/api/queries';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/**
 * Gobierno → Permisos y visibilidad. Matriz INTERACTIVA rol×permiso del OVERLAY subtract-only (ADR-025 §3, Ola 4).
 * Cada celda toggleable RESTA (oculta) o des-resta un par (rol, permiso) que la BASE (`PERMISSION_ROLES` de
 * @veo/policy) YA concede — el overlay NUNCA concede de más. El efectivo se compone `base ∧ ¬override`:
 *   • base=false        → "—" (no aplica; el rol no tiene ese permiso en la base · no toggleable).
 *   • legal-mandatory   → candado (audit:view/verify, finance:payout · Ley 29733 · no restable).
 *   • base=true, ON     → concedido por la base (verde/success).
 *   • base=true, OFF    → restado por vos (el overlay lo oculta en la UI de ese rol).
 * Los cambios se ACUMULAN ("N cambios sin guardar") y se guardan con un único step-up MFA (un PUT por par).
 */

/** Columnas = roles, en orden de jerarquía ascendente (mismo criterio que el rank de AdminRole). */
const ROLE_COLS: { role: AdminRole; short: string; label: string }[] = [
  { role: AdminRole.SUPPORT_L1, short: 'L1', label: 'Soporte L1' },
  { role: AdminRole.SUPPORT_L2, short: 'L2', label: 'Soporte L2' },
  { role: AdminRole.DISPATCHER, short: 'DSP', label: 'Despacho' },
  { role: AdminRole.COMPLIANCE_SUPERVISOR, short: 'CMP', label: 'Cumplimiento' },
  { role: AdminRole.FINANCE, short: 'FIN', label: 'Finanzas' },
  { role: AdminRole.ADMIN, short: 'ADM', label: 'Administrador' },
  { role: AdminRole.SUPERADMIN, short: 'SUP', label: 'Superadmin' },
];

const RESOURCE_LABELS: Record<string, string> = {
  ops: 'Operación en vivo',
  trips: 'Viajes',
  drivers: 'Conductores',
  operators: 'Operadores',
  panics: 'Pánicos',
  fleet: 'Flota',
  finance: 'Finanzas',
  media: 'Video',
  live: 'Cámaras en vivo',
  pricing: 'Precios',
  catalog: 'Catálogo',
  dispatch: 'Dispatch',
  audit: 'Auditoría',
  gobierno: 'Gobierno',
};

const ACTION_LABELS: Record<string, string> = {
  view: 'Ver',
  create: 'Crear',
  approve: 'Aprobar',
  suspend: 'Suspender',
  delete: 'Eliminar',
  ack: 'Reconocer',
  resolve: 'Resolver',
  review: 'Revisar',
  manage: 'Gestionar',
  payout: 'Liquidar',
  refund: 'Reembolsar',
  request: 'Solicitar',
  verify: 'Verificar',
};

function actionOf(permission: Permission): string {
  const action = permission.split(':')[1] ?? permission;
  return ACTION_LABELS[action] ?? action;
}

/** Agrupa los permisos por recurso (prefijo antes de ':') preservando el orden canónico de `PERMISSION_LIST`. */
function groupByResource(): { resource: string; label: string; permissions: Permission[] }[] {
  const order: string[] = [];
  const groups = new Map<string, Permission[]>();
  for (const permission of PERMISSION_LIST) {
    const resource = permission.split(':')[0] ?? permission;
    const existing = groups.get(resource);
    if (existing) {
      existing.push(permission);
    } else {
      groups.set(resource, [permission]);
      order.push(resource);
    }
  }
  return order.map((resource) => ({
    resource,
    label: RESOURCE_LABELS[resource] ?? resource,
    permissions: groups.get(resource) ?? [],
  }));
}

const keyOf = (role: string, permission: string) => `${role}|${permission}`;

export function PermissionsMatrix({ overrides }: { overrides: PermissionOverrideView[] }) {
  const { toast } = useToast();
  const setOverride = useSetPermissionOverride();
  const groups = useMemo(groupByResource, []);

  // Estado del servidor: set de pares RESTADOS (hidden=true). Ausencia = rige la base.
  const serverHidden = useMemo(() => {
    const s = new Set<string>();
    for (const o of overrides) if (o.hidden) s.add(keyOf(o.role, o.permission));
    return s;
  }, [overrides]);

  // Cambios pendientes: key → estado `hidden` DESEADO. Solo contiene celdas que DIFIEREN del servidor.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);

  const effectiveHidden = (key: string) => (pending.has(key) ? pending.get(key)! : serverHidden.has(key));

  function toggleCell(role: string, permission: string) {
    if (saving) return;
    const key = keyOf(role, permission);
    const next = !effectiveHidden(key);
    const map = new Map(pending);
    // Si el nuevo estado coincide con el del servidor, deja de ser un cambio pendiente.
    if (next === serverHidden.has(key)) map.delete(key);
    else map.set(key, next);
    setPending(map);
  }

  const pendingCount = pending.size;

  function discard() {
    setPending(new Map());
  }

  async function save() {
    setSaving(true);
    const remaining = new Map(pending);
    try {
      // Un PUT por par cambiado, secuencial (identity re-valida subtract-only + candado legal en cada uno).
      for (const [key, hidden] of pending) {
        const [role, permission] = key.split('|');
        await setOverride.mutateAsync({ role: role!, permission: permission!, hidden });
        remaining.delete(key);
      }
      setPending(new Map());
      toast({
        tone: 'success',
        title: 'Cambios guardados',
        description: `${pendingCount} ${pendingCount === 1 ? 'cambio aplicado' : 'cambios aplicados'} al overlay de visibilidad.`,
      });
    } catch (e) {
      // Deja pendientes SOLO los que no llegaron a guardarse; propaga para que el StepUpDialog muestre el error.
      setPending(remaining);
      toast({
        tone: 'danger',
        title: 'No se pudieron guardar todos los cambios',
        description: e instanceof Error ? e.message : undefined,
      });
      throw e;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pt-4">
      <Legend />

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              <th className="sticky left-0 z-10 bg-surface px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Permiso
              </th>
              {ROLE_COLS.map((c) => (
                <th
                  key={c.role}
                  className="px-3 py-3 text-center text-xs font-semibold text-ink-muted"
                  title={c.label}
                >
                  {c.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.resource}>
                <tr className="bg-surface-2/30">
                  <td
                    colSpan={ROLE_COLS.length + 1}
                    className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle"
                  >
                    {group.label}
                  </td>
                </tr>
                {group.permissions.map((permission) => {
                  const legal = isLegalMandatoryPermission(permission);
                  return (
                    <tr
                      key={permission}
                      className="border-b border-border last:border-b-0 hover:bg-surface-2/30"
                    >
                      <td className="sticky left-0 z-10 bg-surface px-4 py-2.5">
                        <span className="text-ink">{actionOf(permission)}</span>
                        <span className="ml-2 font-mono text-xs text-ink-subtle">{permission}</span>
                      </td>
                      {ROLE_COLS.map((c) => {
                        const base = baseGrants(c.role, permission);
                        if (!base) {
                          return (
                            <td key={c.role} className="px-3 py-2.5 text-center">
                              <Minus
                                className="mx-auto size-4 text-ink-subtle/40"
                                aria-label={`${c.label}: no aplica`}
                              />
                            </td>
                          );
                        }
                        if (legal) {
                          return (
                            <td key={c.role} className="px-3 py-2.5 text-center">
                              <span
                                className="grid size-6 mx-auto place-items-center text-warn"
                                title="Candado legal (Ley 29733): no se puede restar"
                              >
                                <Lock className="size-4" aria-hidden />
                              </span>
                            </td>
                          );
                        }
                        const key = keyOf(c.role, permission);
                        const hidden = effectiveHidden(key);
                        const dirty = pending.has(key);
                        return (
                          <td key={c.role} className="px-3 py-2.5 text-center">
                            <CellToggle
                              granted={!hidden}
                              dirty={dirty}
                              disabled={saving}
                              label={`${c.label} · ${permission}: ${hidden ? 'restado' : 'concedido por la base'}`}
                              onToggle={() => toggleCell(c.role, permission)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-subtle">
        El overlay solo RESTA: podés ocultar un permiso que la base concede, nunca concederlo de más. Restar un
        permiso lo oculta en la UI del rol; el bloqueo duro server-side (guard <code>base ∧ ¬override</code>) llega
        en la fase siguiente (F1).
      </p>

      {/* Barra de guardado: aparece SOLO con cambios pendientes; el guardado exige step-up MFA fresco. */}
      {pendingCount > 0 ? (
        <div className="sticky bottom-0 z-20 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg">
          <p className="text-sm text-ink-muted">
            <span className="font-semibold text-ink">{pendingCount}</span>{' '}
            {pendingCount === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
              Descartar
            </Button>
            <StepUpDialog
              trigger={
                <Button variant="primary" size="sm" loading={saving}>
                  Guardar cambios
                </Button>
              }
              title="Guardar cambios de permisos"
              description={`Vas a aplicar ${pendingCount} ${pendingCount === 1 ? 'cambio' : 'cambios'} al overlay de visibilidad. El overlay solo RESTA permisos y el cambio queda auditado.`}
              confirmLabel="Guardar"
              onVerified={save}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Toggle compacto de una celda (role="switch"). ON (checked) = concedido por la base; OFF = restado por vos. */
function CellToggle({
  granted,
  dirty,
  disabled,
  label,
  onToggle,
}: {
  granted: boolean;
  dirty: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={granted}
      aria-label={label}
      title={granted ? 'Concedido por la base — clic para restar' : 'Restado por vos — clic para restaurar'}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'mx-auto flex h-5 w-9 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        granted ? 'justify-end bg-success' : 'justify-start border border-border-strong bg-surface-2',
        dirty ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : '',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span className={cn('size-4 rounded-full', granted ? 'bg-success-on' : 'bg-ink')} />
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <LegendItem
        swatch={<span className="flex h-4 w-7 items-center justify-end rounded-full bg-success p-0.5"><span className="size-3 rounded-full bg-success-on" /></span>}
        label="Concedido por la base"
      />
      <LegendItem
        swatch={<span className="flex h-4 w-7 items-center justify-start rounded-full border border-border-strong bg-surface-2 p-0.5"><span className="size-3 rounded-full bg-ink" /></span>}
        label="Restado por vos"
      />
      <LegendItem
        swatch={<Minus className="size-3.5 text-ink-subtle/60" aria-hidden />}
        label="No aplica (—)"
      />
      <LegendItem
        swatch={<Lock className="size-3.5 text-warn" aria-hidden />}
        label="Candado legal · no restable"
      />
      <span className="rounded-full border border-border bg-bg px-3 py-1 text-xs text-ink-muted">
        Solo superadmin
      </span>
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-muted">
      {swatch}
      {label}
    </span>
  );
}
