import { redirect } from 'next/navigation';
import { Activity, MapPin, ShieldAlert } from 'lucide-react';
import { getSession } from '@/lib/server/session';
import { LoginForm } from '@/components/auth/login-form';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: { next?: string };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // Si ya hay sesión válida, no mostrar login.
  const session = await getSession();
  const next = sanitizeNext(searchParams.next);
  if (session) redirect(next);

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Panel de marca (oculto en mobile): navy sobrio, sin gradientes decorativos. */}
      <section className="relative hidden flex-col justify-between bg-brand p-12 text-on-brand lg:flex">
        <p className="font-mono text-sm font-medium tracking-tight">VEO · Centro de control</p>
        <div className="max-w-md space-y-6">
          <h2 className="text-3xl font-semibold leading-tight">
            Operación, seguridad y flota en una sola consola.
          </h2>
          <ul className="space-y-4 text-sm text-on-brand/80">
            <li className="flex items-center gap-3">
              <MapPin className="size-5 shrink-0" aria-hidden />
              Mapa en vivo de conductores y viajes sobre tiles OSM propios.
            </li>
            <li className="flex items-center gap-3">
              <ShieldAlert className="size-5 shrink-0" aria-hidden />
              Alertas de pánico priorizadas con respuesta inmediata.
            </li>
            <li className="flex items-center gap-3">
              <Activity className="size-5 shrink-0" aria-hidden />
              Indicadores de operación en tiempo real.
            </li>
          </ul>
        </div>
        <p className="text-xs text-on-brand/60">Acceso auditado. Soberanía de datos garantizada.</p>
      </section>

      <section className="flex items-center justify-center bg-bg p-8">
        <LoginForm next={next} />
      </section>
    </main>
  );
}

/** Evita open-redirect: solo permite rutas internas absolutas. */
function sanitizeNext(next: string | undefined): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/ops';
}
