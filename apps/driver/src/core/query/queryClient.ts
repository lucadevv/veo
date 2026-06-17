import { QueryClient } from '@tanstack/react-query';

/**
 * Cliente React Query: estado del servidor (cache, reintentos, invalidación).
 * Defaults pensados para red móvil: reintentos acotados y sin refetch al enfocar (RN no tiene foco
 * de ventana como la web). Las mutaciones no reintentan por defecto para no duplicar efectos.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
