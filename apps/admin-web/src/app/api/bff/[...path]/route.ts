import { NextResponse } from 'next/server';
import { authedBffFetch } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';

interface Ctx {
  // Next 15: los `params` de route handlers son asíncronos (Promise).
  params: Promise<{ path: string[] }>;
}

/**
 * Proxy genérico server-side: /api/bff/<...> → admin-bff/<...>.
 * Adjunta el access token (cookie httpOnly) como Bearer y, ante 401, intenta refresh y reintenta.
 * El navegador habla SOLO con este origen; el token nunca se expone a JavaScript.
 */
async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const { path: segments } = await ctx.params;
  const path = '/' + segments.map(encodeURIComponent).join('/');

  const headers: Record<string, string> = {};
  const contentType = req.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const idem = req.headers.get('idempotency-key');
  if (idem) headers['Idempotency-Key'] = idem;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await req.text() : undefined;

  const res = await authedBffFetch(path, {
    method: req.method,
    headers,
    search: url.search,
    body: body && body.length > 0 ? body : undefined,
  });

  const text = await res.text();
  const outHeaders = new Headers();
  const resContentType = res.headers.get('content-type');
  outHeaders.set('content-type', resContentType ?? 'application/json');
  return new NextResponse(text, { status: res.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
