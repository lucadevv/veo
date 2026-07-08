import { NextResponse } from 'next/server';
import { bffFetch } from '@/lib/server/bff';
import { clearSessionCookies, getRefreshToken } from '@/lib/server/cookies';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout-all
 * Cierra la sesión en TODOS los dispositivos: el admin-bff (endpoint @Public) revoca TODAS las sesiones del
 * operador y sella el denylist epoch en identity (ADR-012 §2). El endpoint exige el `refreshToken` en el body
 * (LogoutDto), así que lo leemos de la cookie httpOnly y lo enviamos — el navegador nunca lo ve. Pase lo que
 * pase con la revocación remota, limpiamos las cookies locales para cerrar la sesión de este dispositivo.
 */
export async function POST() {
  try {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      await bffFetch('/auth/logout-all', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    }
  } catch {
    // Aunque falle la revocación remota, limpiamos localmente para cerrar la sesión de este dispositivo.
  }
  await clearSessionCookies();
  return NextResponse.json({ status: 'ok' });
}
