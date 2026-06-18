import { Suspense } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AcceptInviteForm } from '@/components/operators/accept-invite-form';

export const dynamic = 'force-dynamic';

/**
 * Página PÚBLICA de aceptación de invitación de operador (fuera de (dashboard), sin auth/middleware).
 * El operador llega con ?token=… desde el email/enlace, fija su contraseña y queda listo para iniciar
 * sesión. Estética alineada con /login (card centrada sobre `bg`). El form es Client (usa searchParams).
 */
export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-md bg-accent text-accent-on">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <div>
            <p className="font-mono text-lg font-semibold tracking-tight text-ink">VEO</p>
            <p className="text-xs text-ink-muted">Operación y Seguridad</p>
          </div>
        </div>
        <Suspense fallback={null}>
          <AcceptInviteForm />
        </Suspense>
      </div>
    </main>
  );
}
