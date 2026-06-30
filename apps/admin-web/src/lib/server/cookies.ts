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

// maxAge de las cookies de sesión. DEBEN ser >= el TTL del JWT correspondiente (identity-service:
// JWT_ACCESS_TTL / JWT_REFRESH_TTL), si no la COOKIE capa la sesión por debajo del token y se cae antes
// de tiempo (bug histórico: cookie access 15m mientras el JWT vivía 8h → refresh forzado cada 15m; cookie
// refresh 7d mientras el JWT vivía 30-90d → logout al 7º día). Ahora alineadas al TTL del JWT (access 8h /
// refresh 30d) y OVERRIDEABLES por env para que un deploy con otro JWT_*_TTL ajuste sin tocar código.
const ACCESS_MAX_AGE = Number(process.env.ADMIN_ACCESS_COOKIE_MAX_AGE) || 60 * 60 * 8; // 8h
const REFRESH_MAX_AGE = Number(process.env.ADMIN_REFRESH_COOKIE_MAX_AGE) || 60 * 60 * 24 * 30; // 30 días

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
