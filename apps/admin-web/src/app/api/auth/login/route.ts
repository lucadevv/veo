import { NextResponse } from 'next/server';
import { adminLoginResult, isTotpEnrollChallenge } from '@veo/api-client';
import { bffFetch } from '@/lib/server/bff';
import { setAccessCookie, setRefreshCookie } from '@/lib/server/cookies';
import { loginRequest, type LoginResult } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login
 * Proxea a admin-bff POST /auth/login y parsea la respuesta con el contrato canónico `adminLoginResult`:
 *  - `totpEnrollChallenge` (operador sin TOTP) → responde {status:'mfa_required', enrollment:{otpauthUrl}}.
 *    Este flujo NO usa mfaToken: la confirmación reenvía email+password+totp (ver /api/auth/totp/confirm).
 *  - `adminTokens` (login resuelto: operador ya enrolado que envió un totp válido inline) → set cookies
 *    httpOnly access+refresh y responde {status:'authenticated'}.
 * Los tokens jamás llegan al navegador.
 */
export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = loginRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'Email y contraseña son obligatorios.' } },
      { status: 400 },
    );
  }

  const res = await bffFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify(parsed.data),
  });

  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    return NextResponse.json(body ?? { error: { message: 'Credenciales inválidas.' } }, {
      status: res.status,
    });
  }

  const result = adminLoginResult.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'BFF_CONTRACT', message: 'Respuesta de login inesperada del servidor.' } },
      { status: 502 },
    );
  }

  // Operador aún no enrolado en TOTP: el bff devuelve el challenge con la URL otpauth para el QR.
  if (isTotpEnrollChallenge(result.data)) {
    const out: LoginResult = {
      status: 'mfa_required',
      enrollment: { otpauthUrl: result.data.otpauthUrl },
    };
    return NextResponse.json(out);
  }

  // Login resuelto: persistimos los tokens en cookies httpOnly del propio origen.
  setAccessCookie(result.data.accessToken);
  setRefreshCookie(result.data.refreshToken);
  const out: LoginResult = { status: 'authenticated' };
  return NextResponse.json(out);
}
