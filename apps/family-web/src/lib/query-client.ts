import { QueryClient } from '@tanstack/react-query';

/** Crea el QueryClient con defaults conservadores para una vista de seguimiento en vivo. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Los datos en vivo llegan por Socket.IO; el polling es solo red de seguridad.
        staleTime: 15_000,
        gcTime: 60_000,
        retry: 2,
        refetchOnWindowFocus: true,
      },
    },
  });
}
