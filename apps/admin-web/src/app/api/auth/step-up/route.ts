import { NextResponse } from 'next/server';
import { z } from 'zod';
import { stepUpResult } from '@veo/api-client';
import { authedBffFetch } from '@/lib/server/bff';
import { setAccessCookie } from '@/lib/server/cookies';

export const dynamic = 'force-dynamic';

const stepUpRequest = z.object({ code: z.string().length(6) });

/**
 * POST /api/auth/step-up
 * Verifica TOTP para una acción sensible (ej. acceso a video). Proxea a admin-bff POST /auth/step-up
 * con el Bearer actual y el cuerpo {totp} (StepUpDto). Si OK, el bff devuelve `stepUpResult`
 * ({accessToken}) con MFA fresco, que reemplaza la cookie de access.
 */
export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = stepUpRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'Código TOTP inválido.' } },
      { status: 400 },
    );
  }

  const res = await authedBffFetch('/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ totp: parsed.data.code }),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    return NextResponse.json(body ?? { error: { message: 'No se pudo verificar el código.' } }, {
      status: res.status,
    });
  }

  const result = stepUpResult.safeParse(body);
  if (result.success) {
    await setAccessCookie(result.data.accessToken);
  }
  return NextResponse.json({ status: 'ok' });
}
