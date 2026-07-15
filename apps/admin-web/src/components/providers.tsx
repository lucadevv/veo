'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { ThemeProvider } from '@/lib/theme';
import { ToastProvider } from '@/components/ui/toast';

/**
 * Sesión inválida/expirada a mitad de acción (el proxy ya intentó refrescar y también falló → 401). Antes eso caía
 * en un `ErrorState` genérico sin salida; ahora fuerza el re-login (con `next` para volver a donde estabas). 403 NO
 * entra acá — eso es falta de PERMISO (lo maneja `PermissionState`), no de sesión. Guard anti-loop si ya estás en login.
 */
function handleUnauthorized(error: unknown): void {
  if (
    error instanceof ApiError &&
    error.status === 401 &&
    typeof window !== 'undefined' &&
    !window.location.pathname.startsWith('/login')
  ) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
}

/** Providers de cliente: React Query + tema + toasts. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleUnauthorized }),
        mutationCache: new MutationCache({ onError: handleUnauthorized }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // No reintentar errores de autorización/cliente; sí los de red/servidor.
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
