import type { ComponentType, ReactNode } from 'react';
import { CheckCircle2, Clock, Eye, EyeOff, Link2Off, WifiOff, XCircle } from 'lucide-react';

export type StateVariant =
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'ended-completed'
  | 'ended-cancelled'
  | 'unavailable';

interface VariantConfig {
  icon: ComponentType<{ className?: string }>;
  iconClass: string;
  title: string;
  body: string;
}

// Copy humano y tranquilizador, sin jerga ni errores crudos (DESIGN family-web).
const VARIANTS: Record<StateVariant, VariantConfig> = {
  invalid: {
    icon: Link2Off,
    iconClass: 'text-ink-subtle',
    title: 'Este link no es válido',
    body: 'Puede que el enlace esté incompleto. Pídele a tu familiar que te lo comparta de nuevo.',
  },
  expired: {
    icon: Clock,
    iconClass: 'text-ink-subtle',
    title: 'Este link ya caducó',
    body: 'Los links de seguimiento duran poco por seguridad. Pídele a tu familiar uno nuevo.',
  },
  revoked: {
    icon: EyeOff,
    iconClass: 'text-ink-subtle',
    title: 'El viaje dejó de compartirse',
    body: 'Tu familiar desactivó el seguimiento. Si lo necesitas, pídele que lo comparta otra vez.',
  },
  'ended-completed': {
    icon: CheckCircle2,
    iconClass: 'text-success',
    title: 'El viaje terminó',
    body: 'Tu familiar llegó a su destino. Gracias por acompañarlo en el camino.',
  },
  'ended-cancelled': {
    icon: XCircle,
    iconClass: 'text-ink-subtle',
    title: 'El viaje se canceló',
    body: 'Este viaje no se realizó. Si tienes dudas, comunícate con tu familiar.',
  },
  unavailable: {
    icon: WifiOff,
    iconClass: 'text-ink-subtle',
    title: 'No pudimos cargar el viaje',
    body: 'Revisa tu conexión a internet e intenta de nuevo en un momento.',
  },
};

/** Pantalla de estado a pantalla completa, centrada y mobile-first. */
export function StateScreen({ variant, action }: { variant: StateVariant; action?: ReactNode }) {
  const config = VARIANTS[variant];
  const Icon = config.icon;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 py-10">
      <header className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-md bg-brand text-brand-on">
          <Eye className="size-5" aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">VEO Family</span>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <span className="grid size-16 place-items-center rounded-full bg-surface-2">
          <Icon className={`size-8 ${config.iconClass}`} />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{config.title}</h1>
        <p className="mt-3 max-w-sm text-base leading-relaxed text-ink-muted">{config.body}</p>
        {action ? <div className="mt-7">{action}</div> : null}
      </div>
    </main>
  );
}
