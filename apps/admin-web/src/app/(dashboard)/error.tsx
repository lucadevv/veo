'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Error boundary de las rutas del dashboard (App Router). Captura errores inesperados de
 * render/SSR dentro del grupo (dashboard) sin tumbar el shell (Sidebar/Topbar siguen vivos).
 *
 * Por seguridad NO se expone el mensaje/stack crudo al operador: solo un texto genérico y,
 * discretamente, el `digest` para que soporte pueda correlacionar el incidente en los logs.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Deja rastro en consola del cliente para diagnóstico; el reporte real va por la telemetría
    // del runtime de Next, no exponemos el error en la UI.
    console.error('[dashboard] error boundary:', error);
  }, [error]);

  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="animate-scale-in w-full max-w-md p-8 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-lg bg-danger/10 text-danger">
          <AlertTriangle className="size-6" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink">Algo salió mal</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Ocurrió un error inesperado en esta sección. Puedes reintentar o volver al inicio.
        </p>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="primary" size="sm" onClick={() => reset()}>
            <RefreshCw className="size-4" aria-hidden />
            Reintentar
          </Button>
          <Link
            href="/"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-sm font-medium text-ink transition-colors hover:border-border-strong"
          >
            <Home className="size-4" aria-hidden />
            Volver al inicio
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-6 font-mono text-xs text-ink-muted">Código de soporte: {error.digest}</p>
        ) : null}
      </Card>
    </div>
  );
}
