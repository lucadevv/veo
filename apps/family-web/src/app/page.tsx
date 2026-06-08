import type { Metadata } from 'next';
import { Eye, MapPin, ShieldCheck, Clock } from 'lucide-react';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'VEO Family · Sigue el viaje en vivo',
  description: 'Cuando alguien comparte su viaje contigo, lo ves en tiempo real desde el link. Sin app, sin cuenta.',
};

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5 py-10 sm:px-8 sm:py-16">
      <header className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-md bg-brand text-brand-on">
          <Eye className="size-5" aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">VEO Family</span>
      </header>

      <section className="mt-16 sm:mt-24">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Acompaña el viaje de quien quieres, en vivo.
        </h1>
        <p className="mt-5 max-w-prose text-lg leading-relaxed text-ink-muted">
          Cuando un familiar comparte su viaje contigo, recibes un link. Al abrirlo ves dónde está, quién maneja
          y cuánto falta para llegar. No necesitas instalar ninguna app ni crear una cuenta.
        </p>
      </section>

      <section className="mt-14" aria-labelledby="como-funciona">
        <h2 id="como-funciona" className="text-xl font-semibold tracking-tight">
          Cómo funciona el link
        </h2>
        <ol className="mt-6 flex flex-col gap-5">
          <li className="flex gap-4">
            <span className="mt-0.5 text-sm font-semibold tabular text-accent">1</span>
            <p className="text-base leading-relaxed text-ink-muted">
              Tu familiar activa el viaje compartido desde la app de VEO y te envía un link por mensaje.
            </p>
          </li>
          <li className="flex gap-4">
            <span className="mt-0.5 text-sm font-semibold tabular text-accent">2</span>
            <p className="text-base leading-relaxed text-ink-muted">
              Abres el link en tu teléfono. Se abre directo el seguimiento, sin pasos extra.
            </p>
          </li>
          <li className="flex gap-4">
            <span className="mt-0.5 text-sm font-semibold tabular text-accent">3</span>
            <p className="text-base leading-relaxed text-ink-muted">
              Sigues el viaje hasta que llega. El link deja de funcionar cuando el viaje termina.
            </p>
          </li>
        </ol>
      </section>

      <section className="mt-14" aria-labelledby="que-ves">
        <h2 id="que-ves" className="text-xl font-semibold tracking-tight">
          Qué vas a ver
        </h2>
        <dl className="mt-6 flex flex-col divide-y divide-border">
          <div className="flex items-start gap-4 py-4">
            <MapPin className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div>
              <dt className="font-medium">El recorrido en un mapa</dt>
              <dd className="mt-1 text-base leading-relaxed text-ink-muted">
                La ubicación del auto en tiempo real, con el origen y el destino del viaje.
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-4 py-4">
            <Clock className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div>
              <dt className="font-medium">Estado y tiempo de llegada</dt>
              <dd className="mt-1 text-base leading-relaxed text-ink-muted">
                Si va en camino, si llegó o si están en viaje, y cuánto falta para terminar.
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-4 py-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div>
              <dt className="font-medium">Quién maneja</dt>
              <dd className="mt-1 text-base leading-relaxed text-ink-muted">
                Nombre, calificación y los datos del vehículo: placa, modelo y color.
              </dd>
            </div>
          </div>
        </dl>
      </section>

      <section className="mt-14">
        <Card className="bg-surface-2 p-5">
          <h2 className="text-base font-semibold">Tu acceso es solo de lectura</h2>
          <p className="mt-2 text-base leading-relaxed text-ink-muted">
            Con el link puedes mirar el viaje, nada más. No puedes cambiar la ruta ni contactar al conductor sin
            permiso. El link tiene una vigencia corta y caduca solo.
          </p>
        </Card>
      </section>

      <footer className="mt-auto pt-16 text-sm text-ink-subtle">
        <p>Necesitas un link para ver un viaje. Si no tienes uno, pídelo a tu familiar.</p>
        <p className="mt-2">VEO · Movilidad segura</p>
      </footer>
    </main>
  );
}
