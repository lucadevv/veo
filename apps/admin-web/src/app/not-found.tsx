import Link from 'next/link';

// 404 amigable (antes era el default pelado de Next). Cubre cualquier ruta inexistente.
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg p-8 text-center">
      <p className="font-mono text-sm text-ink-muted">VEO · 404</p>
      <h1 className="text-2xl font-semibold text-ink">Esta página no existe</h1>
      <p className="max-w-sm text-sm text-ink-muted">La ruta que buscás no está disponible.</p>
      <Link href="/ops" className="mt-2 text-sm font-medium text-accent hover:underline">
        ← Volver al panel
      </Link>
    </main>
  );
}
