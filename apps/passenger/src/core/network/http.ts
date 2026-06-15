import { HttpClient, mobileRefreshResult } from '@veo/api-client';
import { env } from '../config/env';
import { useSessionStore } from '../session/sessionStore';

/**
 * Cliente HTTP del pasajero: envuelve el `HttpClient` de `@veo/api-client` apuntando
 * al public-bff (`env.publicBffUrl`, incluye `/api/v1`).
 *
 * A diferencia de la web (sesión por cookie httpOnly), el móvil usa Bearer JWT:
 *  - `credentials: 'omit'` (no cookies).
 *  - El `Authorization: Bearer <accessToken>` se inyecta por petición desde el store de sesión.
 *  - Ante un 401 se intenta UN refresh (`POST /auth/refresh`) y se reintenta la petición;
 *    si el refresh falla, se cierra la sesión.
 */

const REFRESH_PATH = '/auth/refresh';
const ACCEPT_LANGUAGE = 'es-PE';

/** Evita refrescos concurrentes: todas las peticiones 401 esperan el mismo refresh. */
let inFlightRefresh: Promise<boolean> | null = null;

/** Intenta renovar los tokens contra el public-bff. Devuelve true si tuvo éxito. */
async function refreshTokens(): Promise<boolean> {
  const { refreshToken, setTokens, clearSession } = useSessionStore.getState();
  if (!refreshToken) {
    return false;
  }
  try {
    const res = await fetch(`${env.publicBffUrl}${REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': ACCEPT_LANGUAGE,
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      // El servidor RECHAZÓ el refresh (token vencido/revocado): sesión EXPIRADA, no un fallo de
      // red. Cierra con motivo 'expired' para que el RootNavigator muestre `SessionExpired`
      // (re-login forzado por seguridad), no el Auth de un logout intencional.
      clearSession('expired');
      return false;
    }
    const parsed = mobileRefreshResult.safeParse(await res.json());
    if (!parsed.success) {
      clearSession('expired');
      return false;
    }
    setTokens(parsed.data.accessToken, parsed.data.refreshToken);
    return true;
  } catch {
    // Error de red: no cerramos sesión (puede ser transitorio), sólo fallamos el refresh.
    return false;
  }
}

/** Construye las cabeceras con el Bearer actual del store de sesión. */
function withAuthHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers);
  const { accessToken } = useSessionStore.getState();
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  headers.set('Accept-Language', ACCEPT_LANGUAGE);
  return headers;
}

/**
 * `fetch` con inyección de Bearer y reintento tras refresh ante 401. El `HttpClient`
 * recibe esta implementación, por lo que su lógica de reintentos (red/5xx/429) sigue intacta.
 */
const authFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, headers: withAuthHeaders(init) });

  if (res.status !== 401 || !useSessionStore.getState().refreshToken) {
    return res;
  }

  inFlightRefresh ??= refreshTokens().finally(() => {
    inFlightRefresh = null;
  });
  const refreshed = await inFlightRefresh;
  if (!refreshed) {
    return res;
  }

  return fetch(input, { ...init, headers: withAuthHeaders(init) });
};

/** Cliente HTTP único del pasajero contra el public-bff. */
export const httpClient = new HttpClient({
  baseUrl: env.publicBffUrl,
  credentials: 'omit',
  headers: { 'Accept-Language': ACCEPT_LANGUAGE },
  fetchImpl: authFetch,
});

export type { HttpClient };
