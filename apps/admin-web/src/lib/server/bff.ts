import { adminBffUrl } from './env';
import { getAccessToken, getRefreshToken, setAccessCookie, setRefreshCookie } from './cookies';

/**
 * Cliente server-side hacia el admin-bff. El access token vive en una cookie httpOnly
 * y se adjunta aquí como `Authorization: Bearer`. Ante 401 se intenta refresh (rotación)
 * UNA vez y se reintenta. El navegador nunca ve el token.
 *
 * IMPORTANTE: solo invocar desde Route Handlers / Server Actions (escriben cookies).
 */

export interface BffFetchInit {
  method?: string;
  /** Cuerpo ya serializado (string) o undefined. */
  body?: string;
  headers?: Record<string, string>;
  search?: string;
}

/** Llamada cruda al bff sin lógica de sesión. */
export async function bffFetch(path: string, init: BffFetchInit = {}): Promise<Response> {
  const url = adminBffUrl() + (path.startsWith('/') ? path : `/${path}`) + (init.search ?? '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'es-PE',
    ...init.headers,
  };
  if (init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    cache: 'no-store',
  });
}

interface RefreshResponse {
  accessToken?: string;
  refreshToken?: string;
}

/**
 * SINGLE-FLIGHT del refresh: si ya hay una rotación EN CURSO, los demás llamadores ESPERAN esa misma
 * promesa en vez de iniciar otra. Sin esto, varios requests concurrentes que vencen a la vez (un page-load
 * con N queries en paralelo) disparan N refreshes con el MISMO refresh token. identity rota el jti single-use
 * e invalida el anterior tras el 1ro → los N-1 restantes presentan un jti YA ROTADO → la REUSE-DETECTION lo
 * trata como ROBO de token y MATA la sesión entera (toda la familia). Ese era el "la sesión expira muy rápido":
 * no expiraba, se AUTODESTRUÍA por la carrera. El single-flight colapsa los N en UNA sola rotación.
 *
 * El cache vive a nivel de módulo (compartido entre invocaciones del mismo proceso Next). La cookie la escribe
 * SOLO el `doRefresh` ganador (en su contexto de request); los que esperan reciben el token resuelto y reintentan
 * con él directo (authedBffFetch usa el valor devuelto, no re-lee la cookie).
 */
let inFlightRefresh: Promise<string | null> | null = null;

/** Intenta rotar el access token usando el refresh de la cookie. Devuelve el nuevo access o null. */
export async function refreshAccessToken(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;
  const res = await bffFetch('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as RefreshResponse | null;
  if (!data?.accessToken) return null;
  await setAccessCookie(data.accessToken);
  if (data.refreshToken) await setRefreshCookie(data.refreshToken);
  return data.accessToken;
}

/**
 * Llamada autenticada con reintento por refresh ante 401. Devuelve la Response del bff
 * (el llamador decide cómo serializarla). Solo válida en contexto de Route Handler.
 */
export async function authedBffFetch(path: string, init: BffFetchInit = {}): Promise<Response> {
  const access = await getAccessToken();
  const withAuth = (token: string | undefined): BffFetchInit => ({
    ...init,
    headers: {
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  const first = await bffFetch(path, withAuth(access));
  if (first.status !== 401) return first;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return first;
  return bffFetch(path, withAuth(refreshed));
}
