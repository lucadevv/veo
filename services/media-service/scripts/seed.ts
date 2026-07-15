/**
 * Seed DEV de media: siembra solicitudes de acceso a video (BR-S02) en estados variados para poder
 * probar el panel admin de "Media / Solicitudes de acceso" sin el flujo real (operador pide → supervisor
 * aprueba/rechaza). Idempotente (upsert por id fijo). Uso:
 *   DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo?schema=media pnpm --filter @veo/media-service db:seed
 *
 * Gating: solo en entornos NO endurecidos (NODE_ENV!=production). JAMÁS se siembra en producción.
 *
 * Notas de coherencia con lo que consume el admin-bff (MediaAccessRequestView / requesterDirectory):
 *  - `requestedByEmail` usa emails de operadores DEV reales (identity seed) → el bff enriquece nombre+rol
 *    por email (dispatcher/support piden; compliance decide). Cuatro-ojos: el aprobador ≠ el solicitante.
 *  - `segmentId` queda null (solicitud "por viaje completo", válido por schema) — approve/reject NO lo
 *    requieren; solo el streaming necesita un segmento (fuera de alcance de este seed).
 *  - `reason` > 20 chars (CHECK a nivel DB · BR-S02).
 */
import { PrismaClient, type VideoAccessStatus } from '../src/generated/prisma';

const prisma = new PrismaClient();

// UUIDs deterministas de operadores DEV (solo para poblar requestedBy/approvedBy/rejectedBy; la
// vista enriquece por EMAIL, no por id). No referencian AdminUser reales — cuatro-ojos igual pasa
// porque el userId real del compliance logueado ≠ estos ids fijos.
const OP_DISPATCHER = '0a000000-0000-4000-8000-000000000001';
const OP_SUPPORT_L1 = '0a000000-0000-4000-8000-000000000002';
const OP_SUPPORT_L2 = '0a000000-0000-4000-8000-000000000003';
const OP_COMPLIANCE = '0a000000-0000-4000-8000-000000000004';

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

interface AccessSeed {
  id: string;
  tripId: string;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: VideoAccessStatus;
  createdAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  signedUrlExpiresAt?: Date;
}

// 4 solicitudes DEV: 2 PENDING (para probar aprobar/rechazar en la UI) + 1 APPROVED + 1 REJECTED.
const REQUESTS: readonly AccessSeed[] = [
  {
    id: 'b0a11ce0-0000-4000-8000-000000000001',
    tripId: 'c0ffee00-0000-4000-8000-000000000001',
    requestedBy: OP_DISPATCHER,
    requestedByEmail: 'dispatcher@veo.pe',
    reason: 'Revisión de pánico reportado por la pasajera durante el viaje nocturno.',
    status: 'PENDING',
    createdAt: hoursAgo(2),
  },
  {
    id: 'b0a11ce0-0000-4000-8000-000000000002',
    tripId: 'c0ffee00-0000-4000-8000-000000000002',
    requestedBy: OP_SUPPORT_L2,
    requestedByEmail: 'support-l2@veo.pe',
    reason: 'Queja del pasajero por conducción imprudente — verificar cámara de cabina.',
    status: 'PENDING',
    createdAt: hoursAgo(5),
  },
  {
    id: 'b0a11ce0-0000-4000-8000-000000000003',
    tripId: 'c0ffee00-0000-4000-8000-000000000003',
    requestedBy: OP_SUPPORT_L2,
    requestedByEmail: 'support-l2@veo.pe',
    reason: 'Objeto olvidado a bordo — confirmar visualmente el asiento trasero del vehículo.',
    status: 'APPROVED',
    createdAt: hoursAgo(26),
    approvedBy: OP_COMPLIANCE,
    approvedAt: hoursAgo(25),
    signedUrlExpiresAt: hoursAgo(24),
  },
  {
    id: 'b0a11ce0-0000-4000-8000-000000000004',
    tripId: 'c0ffee00-0000-4000-8000-000000000004',
    requestedBy: OP_SUPPORT_L1,
    requestedByEmail: 'support-l1@veo.pe',
    reason: 'Solicitud sin incidente asociado — no cumple criterio de acceso a video (BR-S02).',
    status: 'REJECTED',
    createdAt: hoursAgo(50),
    rejectedBy: OP_COMPLIANCE,
    rejectedAt: hoursAgo(49),
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.warn('Seed omitido: NODE_ENV=production (media NO se siembra en producción).');
    return;
  }

  for (const r of REQUESTS) {
    // Campos de decisión (approve/reject) SOLO se setean en el estado correspondiente; el resto null.
    const decisionFields = {
      approvedBy: r.approvedBy ?? null,
      approvedAt: r.approvedAt ?? null,
      rejectedBy: r.rejectedBy ?? null,
      rejectedAt: r.rejectedAt ?? null,
      signedUrlExpiresAt: r.signedUrlExpiresAt ?? null,
    };
    await prisma.videoAccessRequest.upsert({
      where: { id: r.id },
      // Re-seed RE-ARMA los estados (vuelve a dejar los PENDING pendientes) para poder re-probar la UI.
      update: {
        tripId: r.tripId,
        requestedBy: r.requestedBy,
        requestedByEmail: r.requestedByEmail,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        ...decisionFields,
      },
      create: {
        id: r.id,
        segmentId: null,
        tripId: r.tripId,
        requestedBy: r.requestedBy,
        requestedByEmail: r.requestedByEmail,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        ...decisionFields,
      },
    });
  }

  const counts = REQUESTS.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.warn(
    `Solicitudes de acceso a video sembradas (${REQUESTS.length}): ` +
      Object.entries(counts)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ') +
      '. IDs b0a11ce0-…-0000000000{01..04}. Probá aprobar/rechazar los PENDING en el panel de Media.',
  );
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
