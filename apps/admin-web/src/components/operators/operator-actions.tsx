'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound, MoreHorizontal, Send, Ban, XCircle } from 'lucide-react';
import { useReinviteOperator, useRejectOperator } from '@/lib/api/queries';
import { operatorStatus } from '@/lib/api/schemas';
import type { Operator, ReinviteOperatorResult } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { dateTime } from '@/lib/formatters';
import { stepUp } from '@/lib/api/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Re-emite la invitación de un operador INVITED. El endpoint del bff lleva @RequireStepUpMfa, así que
 * verificamos TOTP fresco ANTES (mismo patrón que NewOperatorDialog/LiveAccessDialog). Tras reinvitar,
 * mostramos el nuevo link + vencimiento (con COPY) y mantenemos el diálogo abierto. El backend reenvía
 * el link por email. El servidor revalida @Roles + step-up.
 */
function ReinviteDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const { toast } = useToast();
  const reinvite = useReinviteOperator();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReinviteOperatorResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await stepUp(code);
      const res = await reinvite.mutateAsync({ id: operator.id });
      setResult(res);
      setCode('');
      toast({ tone: 'success', title: 'Invitación reenviada', description: operator.email });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo reenviar la invitación.');
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ tone: 'danger', title: 'No se pudo copiar el enlace' });
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="size-5 text-success" aria-hidden />
                Invitación reenviada
              </DialogTitle>
              <DialogDescription>
                Nuevo enlace para {operator.email}. También se reenvió por email.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <Field label="Enlace de invitación">
                <div className="flex items-center gap-2">
                  <Input readOnly value={result.inviteUrl} className="font-mono text-xs" />
                  <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                    {copied ? (
                      <Check className="size-4 text-success" aria-hidden />
                    ) : (
                      <Copy className="size-4" aria-hidden />
                    )}
                    {copied ? 'Copiado' : 'Copiar'}
                  </Button>
                </div>
              </Field>
              <p className="text-xs text-ink-muted">
                Vence el <span className="text-ink">{dateTime(result.expiresAt)}</span>.
              </p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="primary">Listo</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-5 text-accent" aria-hidden />
                Reenviar invitación
              </DialogTitle>
              <DialogDescription>
                Se generará un nuevo enlace para {operator.email}. Verifica tu segundo factor.
              </DialogDescription>
            </DialogHeader>
            <Field label="Código TOTP" error={error ?? undefined}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="text-center font-mono text-lg tracking-[0.4em]"
                placeholder="••••••"
              />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancelar</Button>
              </DialogClose>
              <Button
                variant="primary"
                loading={pending}
                disabled={code.length < 6}
                onClick={() => void submit()}
              >
                Reenviar
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirmación controlada de cancelar invitación (INVITED) / suspender operador (ACTIVE). Controlada
 * (no usa ConfirmDialog, que es uncontrolled-by-trigger) porque se abre desde un ítem del dropdown.
 */
function RejectDialog({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const { toast } = useToast();
  const reject = useRejectOperator();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isInvited = operator.status === operatorStatus.enum.INVITED;

  async function confirm() {
    setError(null);
    setPending(true);
    try {
      await reject.mutateAsync({ id: operator.id });
      toast({
        tone: 'success',
        title: isInvited ? 'Invitación cancelada' : 'Operador suspendido',
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la acción.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isInvited ? 'Cancelar invitación' : 'Suspender operador'}</DialogTitle>
          <DialogDescription>
            {isInvited
              ? `Se cancelará la invitación de ${operator.email}. El enlace dejará de funcionar. Esta acción queda auditada.`
              : `Se revocará el acceso de ${operator.email} al panel. Esta acción queda auditada.`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancelar</Button>
          </DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void confirm()}>
            {isInvited ? 'Cancelar invitación' : 'Suspender'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type RowDialog = 'reinvite' | 'reject' | null;

/**
 * Acciones por fila de un operador. INVITED → reenviar invitación (step-up) o cancelar; ACTIVE →
 * suspender/revocar. Gated por `operators:view` (ADMIN/SUPERADMIN); el admin-bff revalida server-side.
 */
export function OperatorActions({ operator }: { operator: Operator }) {
  const user = useSession();
  const [dialog, setDialog] = useState<RowDialog>(null);

  if (!can(user, 'operators:view')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  // SUSPENDED/REJECTED no ofrecen acciones (estado terminal en la UI).
  const isInvited = operator.status === operatorStatus.enum.INVITED;
  const isActive = operator.status === operatorStatus.enum.ACTIVE;
  if (!isInvited && !isActive) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Acciones del operador">
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isInvited ? (
            <>
              <DropdownMenuItem onSelect={() => setDialog('reinvite')}>
                <Send className="size-4" aria-hidden />
                Reenviar invitación
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setDialog('reject')}
                className="text-danger data-[highlighted]:bg-danger/10"
              >
                <XCircle className="size-4" aria-hidden />
                Cancelar invitación
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              onSelect={() => setDialog('reject')}
              className="text-danger data-[highlighted]:bg-danger/10"
            >
              <Ban className="size-4" aria-hidden />
              Suspender / Revocar
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === 'reinvite' ? (
        <ReinviteDialog operator={operator} onClose={() => setDialog(null)} />
      ) : null}

      {dialog === 'reject' ? (
        <RejectDialog operator={operator} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}
