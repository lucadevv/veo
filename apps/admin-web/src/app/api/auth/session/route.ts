import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/session
 * Devuelve el sessionUser del admin-bff (vía cookie httpOnly) o 401 si no hay sesión.
 * Lo usa el middleware y el cliente para conocer roles y estado MFA.
 */
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sin sesión activa.' } },
      { status: 401 },
    );
  }
  return NextResponse.json(user);
}
