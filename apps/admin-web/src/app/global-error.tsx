'use client';

import { useEffect } from 'react';

/**
 * Error boundary de ÚLTIMO recurso (App Router). Solo se activa cuando falla el root layout,
 * por lo que reemplaza por completo el documento: DEBE renderizar su propio <html> y <body>
 * (requisito de Next.js para global-error).
 *
 * Al ser el último recurso no dependemos de los tokens del design system ni de Tailwind (que
 * podrían no haber cargado si el fallo es temprano — globals.css vive en el root layout, que
 * este boundary REEMPLAZA): los estilos van inline. Los colores se tokenizan en `palette`
 * (abajo), que espeja los nombres semánticos del sistema (bg/surface/ink/…) pero con valores
 * LITERALES a propósito: paleta autocontenida del lienzo negro de marca, igual en claro/oscuro.
 * Por seguridad no se expone el mensaje/stack crudo; solo un texto genérico y, discretamente,
 * el `digest` para soporte.
 */

/** Paleta autocontenida del último recurso (ver docstring: acá NO hay CSS vars garantizadas). */
const palette = {
  /** Lienzo negro de marca (fondo del documento; también tinta del botón invertido). */
  bg: '#000000',
  /** Tarjeta sobre el lienzo. */
  surface: '#0a0a0a',
  /** Borde de la tarjeta. */
  border: '#262626',
  /** Tinta principal (texto; también fondo del botón invertido). */
  ink: '#fafafa',
  /** Tinta secundaria (descripción, digest). */
  inkMuted: '#a3a3a3',
  /** Rojo de error (glifo "!"). */
  danger: '#f87171',
  /** Fondo tenue del glifo de error (danger al 12%). */
  dangerBg: 'rgba(239, 68, 68, 0.12)',
} as const;
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
          backgroundColor: palette.bg,
          color: palette.ink,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          role="alert"
          style={{
            width: '100%',
            maxWidth: '420px',
            textAlign: 'center',
            border: `1px solid ${palette.border}`,
            borderRadius: '12px',
            backgroundColor: palette.surface,
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
              backgroundColor: palette.dangerBg,
              color: palette.danger,
              fontSize: '24px',
              lineHeight: 1,
            }}
          >
            !
          </div>
          <h1 style={{ margin: '16px 0 0', fontSize: '18px', fontWeight: 600 }}>Algo salió mal</h1>
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: palette.inkMuted }}>
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
              // Botón invertido: tinta sobre lienzo (ink de fondo, bg como texto).
              color: palette.bg,
              backgroundColor: palette.ink,
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
                color: palette.inkMuted,
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
