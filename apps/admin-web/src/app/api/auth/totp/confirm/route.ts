import { NextResponse } from 'next/server';
import { z } from 'zod';
import { adminTokens } from '@veo/api-client';
import { bffFetch } from '@/lib/server/bff';
import { setAccessCookie, setRefreshCookie } from '@/lib/server/cookies';

export const dynamic = 'force-dynamic';

/**
 * Cuerpo del cliente: reenvía credenciales + el primer código TOTP. identity-service exige
 * {email, password, totp} para confirmar el enrolamiento (no existe un mfaToken intermedio).
 */
const confirmRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  code: z.string().length(6),
});

/**
 * POST /api/auth/totp/confirm
 * Completa el primer enrolamiento TOTP: proxea a admin-bff POST /auth/totp/confirm con
 * {email, password, totp}. Si OK, el bff devuelve `adminTokens` (con MFA fresco) que persistimos
 * en cookies httpOnly. Los tokens nunca llegan al navegador.
 */
export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = confirmRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'Datos de confirmación TOTP inválidos.' } },
      { status: 400 },
    );
  }

  const res = await bffFetch('/auth/totp/confirm', {
    method: 'POST',
    body: JSON.stringify({
      email: parsed.data.email,
      password: parsed.data.password,
      totp: parsed.data.code,
    }),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    return NextResponse.json(body ?? { error: { message: 'Código TOTP incorrecto.' } }, {
      status: res.status,
    });
  }

  const tokens = adminTokens.safeParse(body);
  if (!tokens.success) {
    return NextResponse.json(
      { error: { code: 'BFF_CONTRACT', message: 'Respuesta inesperada al confirmar TOTP.' } },
      { status: 502 },
    );
  }

  await setAccessCookie(tokens.data.accessToken);
  await setRefreshCookie(tokens.data.refreshToken);
  return NextResponse.json({ status: 'authenticated' });
}
