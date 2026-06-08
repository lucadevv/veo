import { NextResponse } from 'next/server';
import { wsTicket } from '@veo/api-client';
import { authedBffFetch } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/ws-ticket
 * Solicita al admin-bff un ticket efímero de un solo uso (POST /auth/ws-ticket) con el Bearer de la
 * cookie. El navegador pasa el ticket en el handshake de Socket.IO `/ops`; el JWT de larga vida nunca
 * sale del servidor. La respuesta se valida con el contrato `wsTicket` ({ticket, expiresAt}).
 */
export async function GET() {
  const res = await authedBffFetch('/auth/ws-ticket', { method: 'POST', body: JSON.stringify({}) });
  if (!res.ok) {
    return NextResponse.json(
      { error: { code: 'WS_TICKET', message: 'No se pudo obtener ticket de tiempo real.' } },
      { status: res.status },
    );
  }

  const parsed = wsTicket.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'BFF_CONTRACT', message: 'Ticket de tiempo real inesperado.' } },
      { status: 502 },
    );
  }

  return NextResponse.json(parsed.data);
}
