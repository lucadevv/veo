'use client';

import { useEffect } from 'react';

/**
 * Error boundary de ÚLTIMO recurso (App Router). Solo se activa cuando falla el root layout,
 * por lo que reemplaza por completo el documento: DEBE renderizar su propio <html> y <body>
 * (requisito de Next.js para global-error).
 *
 * Al ser el último recurso no dependemos de los tokens del design system ni de Tailwind (que
 * podrían no haber cargado si el fallo es temprano): los estilos van inline, alineados a la
 * marca VEO (lienzo negro #000000). Por seguridad no se expone el mensaje/stack crudo; solo
 * un texto genérico y, discretamente, el `digest` para soporte.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global] error boundary:', error);
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          backgroundColor: '#000000',
          color: '#fafafa',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          role="alert"
          style={{
            width: '100%',
            maxWidth: '420px',
            textAlign: 'center',
            border: '1px solid #262626',
            borderRadius: '12px',
            backgroundColor: '#0a0a0a',
            padding: '32px',
          }}
        >
          <div
            aria-hidden
            style={{
              margin: '0 auto',
              display: 'grid',
              placeItems: 'center',
              width: '48px',
              height: '48px',
              borderRadius: '10px',
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              color: '#f87171',
              fontSize: '24px',
              lineHeight: 1,
            }}
          >
            !
          </div>
          <h1 style={{ margin: '16px 0 0', fontSize: '18px', fontWeight: 600 }}>
            Algo salió mal
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#a3a3a3' }}>
            Ocurrió un error inesperado. Intenta recargar la aplicación.
          </p>

          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: '24px',
              height: '44px',
              padding: '0 20px',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 600,
              color: '#000000',
              backgroundColor: '#fafafa',
            }}
          >
            Reintentar
          </button>

          {error.digest ? (
            <p
              style={{
                margin: '24px 0 0',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '12px',
                color: '#a3a3a3',
              }}
            >
              Código de soporte: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
