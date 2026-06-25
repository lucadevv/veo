import { redirect } from 'next/navigation';
import { getSession } from '@/lib/server/session';
import { LoginForm } from '@/components/auth/login-form';
import { LoginBrandVideo } from '@/components/auth/login-brand-video';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage(props: LoginPageProps) {
  const searchParams = await props.searchParams;
  // Si ya hay sesión válida, no mostrar login.
  const session = await getSession();
  const next = sanitizeNext(searchParams.next);
  if (session) redirect(next);

  return (
    <main className="relative min-h-[100dvh] bg-bg">
      {/* Fondo FIJO: cubre el viewport siempre y NO scrollea con el contenido. Así, en ventanas
          bajas, el form puede scrollear sin que el video se mueva ni se corte nada. */}
      <div aria-hidden className="fixed inset-0 z-0 overflow-hidden">
        {/* Video a sangre completa: toda la pantalla es el lienzo. Sin archivo, cae al negro. */}
        <LoginBrandVideo />
        {/* Scrim MÍNIMO: el video manda. Base leve en mobile; vignettes arriba/abajo que anclan
            rótulo y señalética con contraste. El form lleva su propio panel glass. */}
        <div className="absolute inset-0 bg-bg/35 lg:bg-transparent" />
        {/* Arriba: cielo brillante → gradiente ALTO y SUAVE (arranca en 80%, NO negro puro) que se
            lee como neblina atmosférica, no como banda dura. La altura difumina el borde. */}
        <div className="absolute inset-x-0 top-0 h-52 bg-gradient-to-b from-bg/80 via-bg/35 to-transparent" />
        {/* Abajo: la ciudad baja ya es oscura → apenas un velo, no una banda negra. */}
        <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-bg/38 via-bg/10 to-transparent" />
        {/* Hairline de marca arriba: el ÚNICO azul, preciso — no inundación. */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand to-transparent opacity-70" />
      </div>

      {/* Contenido: flujo normal sobre el fondo fijo. Scrollea si la ventana no le da la altura. */}
      <div className="relative z-10 flex min-h-[100dvh] flex-col">
        <header className="animate-rise shrink-0 p-8 lg:p-12">
          <p className="text-on-media font-mono text-xs font-semibold uppercase tracking-[0.25em] text-ink">
            VEO · Centro de control
          </p>
        </header>

        {/* Form a la DERECHA en panel glass (el video se nota detrás, el form se lee). El `py`
            da respiro y permite scroll en ventanas bajas sin cortar el botón. */}
        <div className="flex flex-1 items-center justify-center px-6 py-6 lg:justify-end lg:px-16">
          <div
            className="animate-rise w-full max-w-sm rounded-2xl border border-ink/10 bg-bg/60 p-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_64px_-24px_rgba(0,0,0,0.7)] backdrop-blur-xl"
            style={{ animationDelay: '120ms' }}
          >
            <LoginForm next={next} />
          </div>
        </div>

        {/* Señalética decorativa: solo en pantallas con aire (sm+); en mobile estorba el form. */}
        <footer className="animate-rise hidden shrink-0 p-8 sm:block lg:p-12" style={{ animationDelay: '240ms' }}>
          <div className="text-on-media flex items-center gap-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink">
            <span>Mapa en vivo</span>
            <span aria-hidden className="h-3 w-px bg-ink/40" />
            <span>Pánico priorizado</span>
            <span aria-hidden className="h-3 w-px bg-ink/40" />
            <span>Auditoría inmutable</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

/** Evita open-redirect: solo permite rutas internas absolutas. */
function sanitizeNext(next: string | undefined): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/ops';
}
