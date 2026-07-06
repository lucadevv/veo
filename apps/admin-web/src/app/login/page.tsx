import { redirect } from 'next/navigation';
import { Radar, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getSession } from '@/lib/server/session';
import { LoginForm } from '@/components/auth/login-form';
import { LoginBrandVideo } from '@/components/auth/login-brand-video';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

/** Pilares de valor de la columna de marca. Reemplazan la señalética suelta del footer por una propuesta
 *  legible con jerarquía. Los iconos son los mismos que usa el sidebar (coherencia de lenguaje visual). */
const PILLARS = [
  { icon: Radar, label: 'Mapa en vivo', desc: 'Cada viaje y conductor, en tiempo real.' },
  { icon: ShieldAlert, label: 'Pánico priorizado', desc: 'Alertas de emergencia al frente, sin ruido.' },
  { icon: ScrollText, label: 'Auditoría inmutable', desc: 'Toda acción sensible deja traza WORM.' },
] as const;

export default async function LoginPage(props: LoginPageProps) {
  const searchParams = await props.searchParams;
  // Si ya hay sesión válida, no mostrar login.
  const session = await getSession();
  const next = sanitizeNext(searchParams.next);
  if (session) redirect(next);

  return (
    <main className="relative min-h-[100dvh] bg-bg">
      {/* Fondo FIJO: cubre el viewport siempre y NO scrollea con el contenido. En ventanas bajas, el form
          scrollea sin que el video se mueva ni se corte nada. */}
      <div aria-hidden className="fixed inset-0 z-0 overflow-hidden">
        {/* Video a sangre completa: toda la pantalla es el lienzo. Sin archivo, cae al negro. */}
        <LoginBrandVideo />
        {/* Velo global: fuerte en mobile (el form necesita fondo), leve en desktop (el video manda). */}
        <div className="absolute inset-0 bg-bg/45 lg:bg-bg/25" />
        {/* Gradiente izquierdo: ancla la columna de marca con contraste, solo en desktop. El tercio derecho
            (donde vive la tarjeta glass) queda con el video más limpio detrás. */}
        <div className="absolute inset-y-0 left-0 hidden w-2/3 bg-gradient-to-r from-bg/90 via-bg/45 to-transparent lg:block" />
        {/* Viñeta superior: cielo brillante → gradiente alto y suave (neblina, no banda dura). */}
        <div className="absolute inset-x-0 top-0 h-52 bg-gradient-to-b from-bg/80 via-bg/35 to-transparent" />
        {/* Viñeta inferior: la ciudad baja ya es oscura → apenas un velo. */}
        <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-bg/45 via-bg/10 to-transparent" />
        {/* Hairline de marca arriba: el único azul, preciso — no inundación. */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand to-transparent opacity-70" />
      </div>

      {/* Contenido: flujo normal sobre el fondo fijo. Scrollea si la ventana no le da la altura. */}
      <div className="relative z-10 flex min-h-[100dvh] flex-col">
        <header className="animate-rise shrink-0 p-8 lg:p-12">
          <p className="text-on-media font-mono text-xs font-semibold uppercase tracking-[0.25em] text-ink">
            VEO · Centro de control
          </p>
        </header>

        {/* Split: columna de marca a la IZQUIERDA (solo desktop) + tarjeta de auth a la DERECHA. En mobile
            solo la tarjeta (centrada); la columna estorbaría. */}
        <div className="flex flex-1 items-center justify-center gap-16 px-6 py-6 lg:justify-between lg:px-16 xl:px-24">
          <section className="animate-rise hidden max-w-md flex-col gap-10 lg:flex">
            <div className="flex items-center gap-3.5">
              <div className="grid size-12 place-items-center rounded-lg bg-accent text-accent-on shadow-[0_8px_24px_-6px_rgba(45,127,249,0.45)]">
                <ShieldCheck className="size-6" aria-hidden />
              </div>
              <span className="text-on-media text-4xl font-semibold tracking-tight text-ink">VEO</span>
            </div>

            <div className="space-y-3">
              <h1 className="text-on-media max-w-md text-3xl font-medium leading-tight text-ink">
                Movilidad segura, controlada al segundo.
              </h1>
              <p className="text-on-media max-w-md text-base leading-relaxed text-ink-muted">
                El centro de control de VEO: operación en vivo, seguridad y cumplimiento, en un solo lugar.
              </p>
            </div>

            <ul className="space-y-4">
              {PILLARS.map(({ icon: Icon, label, desc }) => (
                <li key={label} className="flex items-center gap-3.5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent/10 text-accent ring-1 ring-inset ring-accent/20">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div className="text-on-media">
                    <p className="font-semibold text-ink">{label}</p>
                    <p className="text-sm text-ink-subtle">{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Tarjeta de auth en panel glass (el video se nota detrás, el form se lee). */}
          <div
            className="animate-rise w-full max-w-sm rounded-2xl border border-ink/10 bg-bg/60 p-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_64px_-24px_rgba(0,0,0,0.7)] backdrop-blur-xl"
            style={{ animationDelay: '120ms' }}
          >
            <LoginForm next={next} />
          </div>
        </div>

        <footer
          className="animate-rise shrink-0 p-8 lg:p-12"
          style={{ animationDelay: '240ms' }}
        >
          <p className="text-on-media font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Acceso restringido · Cumplimiento Ley 29733
          </p>
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
