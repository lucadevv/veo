import Link from 'next/link';
import { Eye } from 'lucide-react';

/** Página 404 tranquila: orienta a abrir el link compartido. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-md bg-brand text-brand-on">
        <Eye className="size-6" aria-hidden />
      </span>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">No encontramos esta página</h1>
      <p className="mt-3 max-w-sm text-base leading-relaxed text-ink-muted">
        Para ver un viaje necesitas el link que te compartió tu familiar. Si lo tienes, ábrelo de
        nuevo.
      </p>
      <Link
        href="/"
        className="mt-7 inline-flex h-11 items-center rounded-md bg-accent px-4 font-medium text-accent-on transition-transform duration-150 ease-out active:scale-[0.97]"
      >
        Ir al inicio
      </Link>
    </main>
  );
}
