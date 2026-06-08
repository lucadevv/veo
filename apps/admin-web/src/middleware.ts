import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/server/cookies';

/**
 * Gate de sesión para las rutas del dashboard. Comprobación barata por presencia de cookie:
 * si no hay access token, redirige a /login conservando el destino (?next=).
 * La validación autoritativa de sesión + RBAC ocurre en el layout del dashboard (Server
 * Component) vía getSession() → admin-bff GET /auth/session.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has(ACCESS_COOKIE);
  if (hasSession) return NextResponse.next();

  const loginUrl = new URL('/login', req.url);
  const { pathname, search } = req.nextUrl;
  loginUrl.searchParams.set('next', pathname + search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Protege todo salvo /login, las rutas /api, y los estáticos de Next.
  matcher: ['/((?!login|api|_next/static|_next/image|favicon.ico).*)'],
};
