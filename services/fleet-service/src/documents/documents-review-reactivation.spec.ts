/**
 * DocumentsService.review · AUTO-reactivación por DOCUMENTO (cierre del ciclo suspensión↔reactivación).
 *
 * Simétrico a la suspensión por documento crítico vencido: cuando el operador VALIDA (decisión VALID) un
 * documento CRÍTICO DRIVER-scoped que estaba venciéndose, el conductor REGULARIZÓ. El review emite
 * `fleet.driver_reactivated` keyeado por `driverId` (= ownerId del doc DRIVER-scoped, ES el id de perfil) en
 * la MISMA tx. IDEMPOTENTE/SEGURO emitir aunque el conductor no estuviera suspendido: identity reactiva SOLO
 * DOCUMENT_EXPIRED (una DISCIPLINARY queda intacta). NO se emite para docs de VEHICLE, no-críticos, ni rechazos.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentsService } from './documents.service';
import { ReviewDecision } from './dto/document.dto';
import { FleetDocumentStatus, FleetOwnerType, FleetDocumentType } from '../generated/prisma';
import { FleetEventType } from '../events/fleet-events';

const REVIEWER = 'reviewer-1';
const NOW = new Date('2026-06-23T12:00:00.000Z');
const FUTURE = new Date('2027-06-23T00:00:00.000Z'); // expiresAt futuro → VALID al validar.

/** Doc en PENDING_REVIEW con overrides (tipo, owner, expiresAt). */
function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    ownerType: FleetOwnerType.DRIVER,
    ownerId: 'driver-profile-1',
    type: FleetDocumentType.SOAT, // crítico
    status: FleetDocumentStatus.PENDING_REVIEW,
    expiresAt: FUTURE,
    ...over,
  };
}

function makeService(docRow: Record<string, unknown> | null) {
  const outbox: Record<string, unknown>[] = [];
  const tx = {
    fleetDocument: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...docRow, ...data })),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return {};
      }),
    },
  };
  const prisma = {
    read: { fleetDocument: { findUnique: vi.fn(async () => docRow) } },
    write: { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) },
  };
  const config = { getOrThrow: () => 30 };
  const service = new DocumentsService(prisma as never, config as never);
  return { service, outbox };
}

/** Encuentra el evento de reactivación en el outbox (o null). */
function reactivatedPayload(outbox: Record<string, unknown>[]): Record<string, unknown> | null {
  const e = outbox.find((o) => o.eventType === FleetEventType.DRIVER_REACTIVATED);
  if (!e) return null;
  return (e.envelope as { payload: Record<string, unknown> }).payload;
}

describe('DocumentsService.review · auto-reactivación por documento crítico regularizado', () => {
  it('VALIDA un doc crítico (SOAT) DRIVER → VALID → emite fleet.driver_reactivated keyeado por driverId', async () => {
    const { service, outbox } = makeService(doc());
    const updated = await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(updated.status).toBe(FleetDocumentStatus.VALID);
    const payload = reactivatedPayload(outbox);
    expect(payload).not.toBeNull();
    // KEYEADO POR driverId (id de perfil = ownerId del doc DRIVER), NUNCA un userId.
    expect(payload?.driverId).toBe('driver-profile-1');
    expect(payload?.userId).toBeUndefined();
    expect(payload?.documentType).toBe(FleetDocumentType.SOAT);
  });

  it('RECHAZA el doc → NO emite reactivación (un rechazo no regulariza)', async () => {
    const { service, outbox } = makeService(doc());
    await service.review('doc-1', ReviewDecision.REJECTED, REVIEWER, 'foto ilegible', NOW);
    expect(reactivatedPayload(outbox)).toBeNull();
  });

  it('doc NO crítico (DNI) validado → NO emite reactivación (su vencimiento no suspende)', async () => {
    const { service, outbox } = makeService(doc({ type: FleetDocumentType.DNI }));
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(reactivatedPayload(outbox)).toBeNull();
  });

  it('doc crítico de VEHICLE validado → NO emite reactivación por conductor (la suspensión por doc es DRIVER-scoped)', async () => {
    const { service, outbox } = makeService(
      doc({ ownerType: FleetOwnerType.VEHICLE, type: FleetDocumentType.SOAT }),
    );
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(reactivatedPayload(outbox)).toBeNull();
  });

  it('doc crítico validado pero YA VENCIDO (expiresAt pasado) → EXPIRED → suspende, NO reactiva', async () => {
    const PAST = new Date('2026-01-01T00:00:00.000Z');
    const { service, outbox } = makeService(doc({ expiresAt: PAST }));
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    // Cae en EXPIRED → la rama de suspensión, NO la de reactivación (no se regulariza algo ya vencido).
    expect(reactivatedPayload(outbox)).toBeNull();
    expect(outbox.some((o) => o.eventType === FleetEventType.DRIVER_SUSPENDED)).toBe(true);
  });
});
