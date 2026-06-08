import {HttpClient, mobileRefreshResult} from '@veo/api-client';
import {env} from '../config/env';

/**
 * Puerto (abstracción) que el cliente HTTP necesita para leer/escribir los tokens de sesión.
 * La implementación concreta (store Zustand) se inyecta desde el contenedor de DI, evitando que
 * la capa de red dependa de un store específico.
 */
export interface SessionTokenPort {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(tokens: {accessToken: string; refreshToken: string}): void;
  clearSession(): void;
}

// Single-flight: si varias peticiones reciben 401 a la vez, solo un refresh viaja a la red.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(port: SessionTokenPort): Promise<string | null> {
  const refreshToken = port.getRefreshToken();
  if (!refreshToken) {
    return null;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async (): Promise<string | null> => {
      try {
        const res = await fetch(`${env.DRIVER_BFF_URL}/auth/refresh`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json'},
          body: JSON.stringify({refreshToken}),
        });
        if (!res.ok) {
          return null;
        }
        const parsed = mobileRefreshResult.safeParse(await res.json());
        if (!parsed.success) {
          return null;
        }
        port.setTokens(parsed.data);
        return parsed.data.accessToken;
      } catch {
        return null;
      }
    })();
  }

  const token = await refreshInFlight;
  refreshInFlight = null;
  return token;
}

/**
 * Construye el cliente HTTP del driver apuntando al `driver-bff` (`/api/v1`).
 *
 * - Inyecta el `Authorization: Bearer <accessToken>` leído del store de sesión en cada petición.
 * - Ante un 401, intenta UN refresh (single-flight) y reintenta la petición original; si el refresh
 *   falla, limpia la sesión (forzará re-login en la capa de presentación).
 * - `credentials: 'omit'`: el móvil usa Bearer JWT, no cookies (a diferencia de la web).
 */
export function createDriverHttpClient(port: SessionTokenPort): HttpClient {
  const authFetch: typeof fetch = async (input, init) => {
    const firstHeaders = new Headers(init?.headers ?? undefined);
    const access = port.getAccessToken();
    if (access) {
      firstHeaders.set('Authorization', `Bearer ${access}`);
    }

    const first = await fetch(input, {...init, headers: firstHeaders});
    if (first.status !== 401) {
      return first;
    }

    const newAccess = await refreshAccessToken(port);
    if (!newAccess) {
      port.clearSession();
      return first;
    }

    const retryHeaders = new Headers(init?.headers ?? undefined);
    retryHeaders.set('Authorization', `Bearer ${newAccess}`);
    return fetch(input, {...init, headers: retryHeaders});
  };

  return new HttpClient({
    baseUrl: env.DRIVER_BFF_URL,
    credentials: 'omit',
    headers: {'Accept-Language': 'es-PE'},
    fetchImpl: authFetch,
  });
}
