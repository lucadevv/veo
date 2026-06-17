import { cookies } from 'next/headers';

/**
 * Nombres y manejo de las cookies de sesión. Viven SOLO en el origen de admin-web,
 * httpOnly + Secure + SameSite=Lax: el token jamás es accesible desde JavaScript.
 */
export const ACCESS_COOKIE = 'veo_at';
export const REFRESH_COOKIE = 'veo_rt';

const isProd = process.env.NODE_ENV === 'production';

interface SetOpts {
  maxAgeSeconds: number;
  httpOnly?: boolean;
}

function baseOptions(opts: SetOpts) {
  return {
    httpOnly: opts.httpOnly ?? true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: opts.maxAgeSeconds,
  };
}

// Duraciones por defecto (el bff es la autoridad real de expiración del JWT).
const ACCESS_MAX_AGE = 60 * 15; // 15 min
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7; // 7 días

export async function setAccessCookie(token: string): Promise<void> {
  (await cookies()).set(ACCESS_COOKIE, token, baseOptions({ maxAgeSeconds: ACCESS_MAX_AGE }));
}

export async function setRefreshCookie(token: string): Promise<void> {
  (await cookies()).set(REFRESH_COOKIE, token, baseOptions({ maxAgeSeconds: REFRESH_MAX_AGE }));
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

export async function clearSessionCookies(): Promise<void> {
  const c = await cookies();
  c.delete(ACCESS_COOKIE);
  c.delete(REFRESH_COOKIE);
}
