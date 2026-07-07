'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, KeyRound, UserPlus } from 'lucide-react';
import { AdminRole, ADMIN_ROLE_RANK, maxRoleRank } from '@veo/shared-types';
import { stepUp } from '@/lib/api/auth';
import { useCreateOperator } from '@/lib/api/queries';
import type { AdminRoleValue, CreateOperatorResult } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { dateTime } from '@/lib/formatters';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
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

/** Etiqueta humana por rol (espejo de ASSIGNABLE_ROLES histórico, ahora SÍ incluye SUPERADMIN). */
const ROLE_LABELS: Record<AdminRoleValue, string> = {
  SUPPORT_L1: 'Soporte N1',
  SUPPORT_L2: 'Soporte N2',
  DISPATCHER: 'Despachador',
  COMPLIANCE_SUPERVISOR: 'Cumplimiento',
  FINANCE: 'Finanzas',
  ADMIN: 'Administrador',
  SUPERADMIN: 'Superadmin',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Roles que el actor PUEDE otorgar según su rango (anti-escalada `canGrantRoles`): rango estrictamente
 * menor al suyo, salvo SUPERADMIN que sí otorga SUPERADMIN. Solo los offrecemos para no inducir un 403;
 * el servidor revalida igual (la UI no autoriza). Orden ascendente por rango para una lista estable.
 */
function grantableRoles(roles: readonly string[]): AdminRoleValue[] {
  const actorRank = maxRoleRank(roles as AdminRole[]);
  const isSuperadmin = actorRank >= ADMIN_ROLE_RANK[AdminRole.SUPERADMIN];
  return (Object.keys(ROLE_LABELS) as AdminRoleValue[])
    .filter((r) => ADMIN_ROLE_RANK[r] < actorRank || (isSuperadmin && r === AdminRole.SUPERADMIN))
    .sort((a, b) => ADMIN_ROLE_RANK[a] - ADMIN_ROLE_RANK[b]);
}

/**
 * Alta de operador por INVITACIÓN. Doble-auth como LiveAccessDialog: el endpoint del bff lleva
 * @RequireStepUpMfa, así que verificamos TOTP fresco (`stepUp`) ANTES de crear. Tras crear, mostramos
 * el link de invitación (con COPY) + vencimiento y mantenemos el diálogo abierto hasta que el admin lo
 * cierre. El backend además envía el link por email. El servidor revalida @Roles + step-up + anti-escalada.
 */
export function NewOperatorDialog() {
  const user = useSession();
  const { toast } = useToast();
  const create = useCreateOperator();

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<Set<AdminRoleValue>>(new Set());
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateOperatorResult | null>(null);
  const [copied, setCopied] = useState(false);

  const options = useMemo(() => grantableRoles(user.roles), [user.roles]);
  const emailOk = EMAIL_RE.test(email.trim());
  const canSubmit = emailOk && roles.size > 0 && code.length >= 6;

  function reset() {
    setEmail('');
    setRoles(new Set());
    setCode('');
    setError(null);
    setCreated(null);
    setCopied(false);
  }

  function toggle(role: AdminRoleValue) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await stepUp(code); // 1) MFA fresca (el bff exige step-up para crear operadores)
      const result = await create.mutateAsync({ email: email.trim(), roles: [...roles] }); // 2) alta INVITED + link
      setCreated(result);
      setCode('');
      toast({ tone: 'success', title: 'Operador invitado', description: email.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo invitar al operador.');
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ tone: 'danger', title: 'No se pudo copiar el enlace' });
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
      <DialogTrigger asChild>
        <Button size="sm" variant="primary">
          <UserPlus className="size-4" aria-hidden />
          Nuevo operador
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="size-5 text-success" aria-hidden />
                Invitación creada
              </DialogTitle>
              <DialogDescription>
                Comparte este enlace con el operador para que fije su contraseña. También se envió
                por email.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <Field label="Enlace de invitación">
                <div className="flex items-center gap-2">
                  <Input readOnly value={created.inviteUrl} className="font-mono text-xs" />
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
                Vence el <span className="text-ink">{dateTime(created.expiresAt)}</span>. También se
                envió por email.
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
                <UserPlus className="size-5 text-accent" aria-hidden />
                Nuevo operador
              </DialogTitle>
              <DialogDescription>
                Se enviará una invitación al correo para que el operador fije su contraseña. Asigna
                los roles que definen qué puede ver y operar.
              </DialogDescription>
            </DialogHeader>

            <Field
              label="Correo del operador"
              error={!emailOk && email.length > 0 ? 'Ingresa un correo válido.' : undefined}
            >
              <Input
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="nombre@veo.pe"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <fieldset className="flex flex-col gap-2 py-1">
              <legend className="mb-1 text-sm font-medium text-ink">Roles a otorgar</legend>
              {options.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  Tu rango no permite otorgar roles. Contacta a un administrador de mayor jerarquía.
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

            <Field
              label="Código TOTP"
              hint="Crear operadores requiere verificación adicional (queda auditado)."
              error={error ?? undefined}
            >
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
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                <KeyRound className="size-4" aria-hidden />
                Invitar operador
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
