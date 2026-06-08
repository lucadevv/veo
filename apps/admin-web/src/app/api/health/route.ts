import { NextResponse } from 'next/server';

// Liveness/readiness para las probes de K8s. El frontend no tiene dependencias profundas: si el
// server de Next responde, está vivo y listo. Sin caché (siempre fresco, no estático).
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
