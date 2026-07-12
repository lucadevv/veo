'use client';

import { useMemo, useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { stepUp } from '@/lib/api/auth';
import { useChangeOperatorRoles } from '@/lib/api/queries';
import type { AdminRoleValue } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { grantableRoles, ROLE_LABELS } from '@/lib/roles';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { OtpInput } from '@/components/ui/otp-input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Cambia los roles de un operador. Acción SENSIBLE con anti-escalada: solo se ofrecen roles que el actor
 * PUEDE otorgar (rango < propio), y el servidor revalida `canGrantRoles` + step-up MFA. El TOTP se pide solo
 * en prod (espejo del StepUpMfaGuard: en dev el guard devuelve true → se omite).
 */
export function ChangeRoleDialog({
  operatorId,
  currentRoles,
  trigger,
}: {
  operatorId: string;
  currentRoles: readonly string[];
  trigger: React.ReactNode;
}) {
  const user = useSession();
  const { toast } = useToast();
  const change = useChangeOperatorRoles();
  const isProd = process.env.NODE_ENV === 'production';

  const options = useMemo(() => grantableRoles(user.roles), [user.roles]);
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<Set<AdminRoleValue>>(new Set(currentRoles as AdminRoleValue[]));
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setRoles(new Set(currentRoles as AdminRoleValue[]));
    setCode('');
    setError(null);
  }

  function toggle(role: AdminRoleValue) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  const canSubmit = roles.size > 0 && (!isProd || code.length >= 6);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      if (isProd) await stepUp(code);
      await change.mutateAsync({ id: operatorId, roles: [...roles] });
      toast({ tone: 'success', title: 'Roles actualizados' });
      setOpen(false);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el rol.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-accent" aria-hidden />
            Cambiar rol
          </DialogTitle>
          <DialogDescription>
            Definí los roles del operador. Solo se ofrecen los que tu rango puede otorgar; el servidor
            revalida.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2 py-1">
          <legend className="mb-1 text-sm font-medium text-ink">Roles</legend>
          {options.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Tu rango no permite otorgar roles. Contactá a un administrador de mayor jerarquía.
            </p>
          ) : (
            options.map((role) => {
              const checked = roles.has(role);
              return (
                <button
                  key={role}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(role)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    checked
                      ? 'border-accent bg-accent/10 text-ink'
                      : 'border-border text-ink-muted hover:border-border-strong'
                  }`}
                >
                  <span>{ROLE_LABELS[role]}</span>
                  {checked ? <Check className="size-4 text-accent" aria-hidden /> : null}
                </button>
              );
            })
          )}
        </fieldset>

        {isProd ? (
          <Field
            label="Código TOTP"
            hint="Cambiar rol requiere verificación adicional (queda auditado)."
            error={error ?? undefined}
          >
            <OtpInput value={code} onChange={setCode} length={6} />
          </Field>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={pending}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            Guardar roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
