import { redirect } from 'next/navigation';
import { Lock, ShieldCheck, Video } from 'lucide-react';
import { getSession } from '@/lib/server/session';
import { LoginForm } from '@/components/auth/login-form';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

/** Features de la columna de marca (fiel a veo.pen · 01 · Login): una línea, icono + texto. */
const FEATURES = [
  { icon: ShieldCheck, label: 'Verificación biométrica por turno' },
  { icon: Video, label: 'Cámara en vivo todo el viaje' },
  { icon: Lock, label: 'Audit inmutable · Ley 29733' },
] as const;

export default async function LoginPage(props: LoginPageProps) {
  const searchParams = await props.searchParams;
  // Si ya hay sesión válida, no mostrar login.
  const session = await getSession();
  const next = sanitizeNext(searchParams.next);
  if (session) redirect(next);

  return (
    <main className="flex min-h-[100dvh] bg-bg">
      {/* Columna de marca (solo desktop): gradiente azul trust → azul profundo, 135°. */}
      <aside className="bg-brand-gradient hidden w-[560px] shrink-0 flex-col justify-between p-14 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-md bg-white/15">
            <span className="font-display text-2xl font-bold leading-none text-white">V</span>
          </div>
          <span className="font-display text-[22px] font-bold leading-none text-white">VEO</span>
        </div>

        <div className="flex flex-col gap-9">
          <div className="flex flex-col gap-4">
            <h1 className="font-serif text-[42px] font-semibold leading-[1.12] text-white">
              Movilidad segura,
              <br />
              bajo control.
            </h1>
            <p className="max-w-[420px] text-base leading-relaxed text-white/80">
              El panel de operación de VEO. Biometría del conductor, cámara en vivo y pánico — todo
              auditado.
            </p>
          </div>

          <ul className="flex flex-col gap-3.5">
            {FEATURES.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2.5">
                <Icon className="size-[18px] shrink-0 text-white/90" aria-hidden />
                <span className="text-sm text-white/90">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Panel de auth (fondo de página gris claro, tarjeta blanca centrada). */}
      <div className="flex flex-1 items-center justify-center p-6 lg:p-10">
        <div className="w-full max-w-[420px] rounded-xl border border-border bg-surface p-10 shadow-3">
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}

/** Evita open-redirect: solo permite rutas internas absolutas. */
function sanitizeNext(next: string | undefined): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/ops';
}
