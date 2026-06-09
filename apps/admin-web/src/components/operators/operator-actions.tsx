'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useOperatorDecision } from '@/lib/api/queries';
import type { AdminRoleValue, PendingOperator } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Roles asignables desde la UI al aprobar un operador, con etiqueta humana. NO incluye SUPERADMIN
 * (rol raíz, se otorga solo en bootstrap, no auto-servicio). El admin-bff revalida @Roles(ADMIN,SUPERADMIN)
 * server-side; esta lista es solo la UI (que nunca autoriza, solo refleja — MENTORIA capa UI).
 */
const ASSIGNABLE_ROLES: ReadonlyArray<{ value: AdminRoleValue; label: string }> = [
  { value: 'SUPPORT_L1', label: 'Soporte N1' },
  { value: 'SUPPORT_L2', label: 'Soporte N2' },
  { value: 'DISPATCHER', label: 'Despachador' },
  { value: 'COMPLIANCE_SUPERVISOR', label: 'Cumplimiento' },
  { value: 'FINANCE', label: 'Finanzas' },
  { value: 'ADMIN', label: 'Administrador' },
];

/** Acciones de aprobación (con asignación de roles) / rechazo de un operador. Gated por operators:approve. */
export function OperatorActions({ operator }: { operator: PendingOperator }) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useOperatorDecision();
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<Set<AdminRoleValue>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can(user, 'operators:approve')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  function toggle(role: AdminRoleValue) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function handleApprove() {
    setError(null);
    setPending(true);
    try {
      await decision.mutateAsync({ id: operator.id, decision: 'approve', roles: [...roles] });
      toast({ tone: 'success', title: 'Operador aprobado' });
      setOpen(false);
      setRoles(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar el operador.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="primary">
            <Check className="size-4" aria-hidden />
            Aprobar
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aprobar operador</DialogTitle>
            <DialogDescription>
              Asigna los roles de {operator.email}. Define qué puede ver y operar en el panel.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-2 py-2">
            <legend className="sr-only">Roles a asignar</legend>
            {ASSIGNABLE_ROLES.map((role) => {
              const checked = roles.has(role.value);
              return (
                <button
                  key={role.value}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(role.value)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    checked
                      ? 'border-accent bg-accent/10 text-ink'
                      : 'border-border text-ink-muted hover:border-border-strong'
                  }`}>
                  <span>{role.label}</span>
                  {checked ? <Check className="size-4 text-accent" aria-hidden /> : null}
                </button>
              );
            })}
          </fieldset>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={handleApprove} disabled={pending || roles.size === 0}>
              Aprobar con {roles.size} {roles.size === 1 ? 'rol' : 'roles'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <X className="size-4" aria-hidden />
            Rechazar
          </Button>
        }
        title="Rechazar operador"
        description={`Se rechazará el alta de ${operator.email}. Esta acción queda auditada.`}
        confirmLabel="Rechazar"
        variant="danger"
        onConfirm={async () => {
          await decision.mutateAsync({ id: operator.id, decision: 'reject' });
          toast({ tone: 'success', title: 'Operador rechazado' });
        }}
      />
    </div>
  );
}
