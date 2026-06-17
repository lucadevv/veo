import { sessionUser, type SessionUser } from '@veo/api-client';
import { adminBffUrl } from './env';
import { getAccessToken } from './cookies';

/**
 * Lee la sesión del bff (GET /auth/session) usando el access token de la cookie httpOnly.
 * Read-only: apto para Server Components (no rota tokens). Devuelve null si no hay sesión válida.
 */
export async function getSession(): Promise<SessionUser | null> {
  const access = await getAccessToken();
  if (!access) return null;
  try {
    const res = await fetch(`${adminBffUrl()}/auth/session`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${access}`,
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    const parsed = sessionUser.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
