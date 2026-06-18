import { NextResponse } from 'next/server';
import { acceptInviteRequest, acceptInviteResult } from '@veo/api-client';
import { bffFetch } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/invite/accept (PÚBLICO)
 * El operador invitado fija su contraseña con el token de invitación. Proxea a admin-bff
 * POST /auth/invite/accept (@Public) con `bffFetch` CRUDO — sin Bearer: este flujo no tiene sesión
 * (a diferencia del proxy genérico /api/bff/* que adjunta el access token). Pasa por el status del bff
 * (401 invitación inválida/vencida) para que el cliente muestre el mensaje correcto.
 */
export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = acceptInviteRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'Token y contraseña (mín. 10) son obligatorios.' } },
      { status: 400 },
    );
  }

  const res = await bffFetch('/auth/invite/accept', {
    method: 'POST',
    body: JSON.stringify(parsed.data),
  });

  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    return NextResponse.json(body ?? { error: { message: 'No se pudo aceptar la invitación.' } }, {
      status: res.status,
    });
  }

  const result = acceptInviteResult.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'BFF_CONTRACT', message: 'Respuesta inesperada del servidor.' } },
      { status: 502 },
    );
  }
  return NextResponse.json(result.data);
}
