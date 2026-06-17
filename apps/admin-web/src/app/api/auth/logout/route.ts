import { NextResponse } from 'next/server';
import { authedBffFetch } from '@/lib/server/bff';
import { clearSessionCookies } from '@/lib/server/cookies';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout
 * Invalida la sesión en el admin-bff (revoca refresh) y limpia todas las cookies locales.
 */
export async function POST() {
  try {
    await authedBffFetch('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    // Aunque falle la revocación remota, limpiamos localmente para cerrar sesión.
  }
  await clearSessionCookies();
  return NextResponse.json({ status: 'ok' });
}
