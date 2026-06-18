'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { acceptInviteResult } from '@veo/api-client';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Field } from '@/components/ui/field';

const MIN_PASSWORD = 10;

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? `Error ${res.status}`;
}

/**
 * Form de aceptación de invitación. Lee ?token= de la URL, pide contraseña + confirmación (mín. 10,
 * deben coincidir) y la envía a /api/auth/invite/accept (route handler PÚBLICO, sin Bearer). Estados:
 * sin token → error; form; submitting; success (link a /login); error (token inválido/vencido → mensaje
 * amable + pedir nueva invitación). El servidor revalida el token (única autoridad).
 */
export function AcceptInviteForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Sin token en la URL: no hay nada que hacer (enlace roto o accedido a mano).
  if (!token) {
    return (
      <div role="alert" className="space-y-3">
        <div className="grid size-12 place-items-center rounded-lg bg-danger/10 text-danger">
          <AlertTriangle className="size-6" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold text-ink">Enlace inválido</h1>
        <p className="text-sm text-ink-muted">
          Esta invitación no es válida o el enlace está incompleto. Pedí una nueva invitación a tu
          administrador.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="grid size-12 place-items-center rounded-lg bg-success/10 text-success">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-ink">Listo, ya podés iniciar sesión</h1>
          <p className="text-sm text-ink-muted">
            Tu contraseña quedó configurada. Iniciá sesión y configurá tu segundo factor (TOTP).
          </p>
        </div>
        <Link
          href="/login"
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-on transition-colors hover:bg-accent-hover"
        >
          Ir a iniciar sesión
        </Link>
      </div>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= MIN_PASSWORD && confirm === password;

  async function submit() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      acceptInviteResult.parse(await res.json());
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aceptar la invitación.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-5"
      noValidate
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink">
          <KeyRound className="size-5 text-accent" aria-hidden />
          Configurá tu contraseña
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Elegí una contraseña para activar tu cuenta de operador en VEO.
        </p>
      </div>

      <Field
        label={`Contraseña (mín. ${MIN_PASSWORD} caracteres)`}
        error={tooShort ? `Debe tener al menos ${MIN_PASSWORD} caracteres.` : undefined}
      >
        <PasswordInput
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      <Field
        label="Repetí la contraseña"
        error={mismatch ? 'Las contraseñas no coinciden.' : (error ?? undefined)}
      >
        <PasswordInput
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>

      <Button type="submit" className="w-full" loading={pending} disabled={!canSubmit}>
        Activar cuenta
      </Button>
    </form>
  );
}
