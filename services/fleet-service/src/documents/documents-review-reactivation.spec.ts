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
  // review() actual (CAS): findUnique (lectura en-tx) → updateMany (claim atómico) → findUniqueOrThrow (re-lee
  // la fila ya escrita). El mock refleja ESE flujo y acumula el `data` del updateMany para devolver la fila
  // actualizada en findUniqueOrThrow (updateMany en Prisma no devuelve la fila).
  let applied: Record<string, unknown> = { ...(docRow ?? {}) };
  const tx = {
    fleetDocument: {
      findUnique: vi.fn(async () => docRow),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applied = { ...applied, ...data };
        return { count: docRow ? 1 : 0 };
      }),
      findUniqueOrThrow: vi.fn(async () => applied),
    },
    // Rama ITV+VEHICLE del review: chequeo de duplicado (findUnique) + resolución del conductor del vehículo.
    inspection: {
      findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    },
    vehicle: { findUnique: vi.fn(async () => ({ driverId: 'user-owner-1' })) },
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
  const inspections = { createInTx: vi.fn() };
  const service = new DocumentsService(prisma as never, inspections as never, config as never);
  return { service, outbox, inspections, tx };
}

/** Encuentra el evento de reactivación en el outbox (o null). */
function reactivatedPayload(outbox: Record<string, unknown>[]): Record<string, unknown> | null {
  const e = outbox.find((o) => o.eventType === FleetEventType.DRIVER_REACTIVATED);
  if (!e) return null;
  return (e.envelope as { payload: Record<string, unknown> }).payload;
}

/** Encuentra el evento de rechazo de documento en el outbox (o null). */
function documentRejectedPayload(
  outbox: Record<string, unknown>[],
): Record<string, unknown> | null {
  const e = outbox.find((o) => o.eventType === FleetEventType.DOCUMENT_REJECTED);
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

  it('RECHAZA un doc DRIVER → emite fleet.document_rejected (para el push al conductor), keyeado por ownerId (Driver.id)', async () => {
    // Cierra la asimetría de aviso: el rechazo por-documento notifica al conductor. El `reason` viaja en el
    // evento (audit) pero NO al push (PII). ownerId = Driver.id de perfil; el push lo resuelve a userId.
    const { service, outbox } = makeService(doc());
    await service.review('doc-1', ReviewDecision.REJECTED, REVIEWER, 'foto ilegible', NOW);
    const payload = documentRejectedPayload(outbox);
    expect(payload).not.toBeNull();
    expect(payload?.ownerType).toBe(FleetOwnerType.DRIVER);
    expect(payload?.ownerId).toBe('driver-profile-1');
    expect(payload?.documentType).toBe(FleetDocumentType.SOAT);
    expect(payload?.rejectedAt).toBe(NOW.toISOString());
    // El reason (texto libre) NO viaja en el evento (data-minimization §0.7): vive en FleetDocument.rejectionReason.
    expect(payload?.reason).toBeUndefined();
  });

  it('RECHAZA un doc de VEHICLE → NO emite fleet.document_rejected (no hay conductor a quien avisar)', async () => {
    const { service, outbox } = makeService(
      doc({ ownerType: FleetOwnerType.VEHICLE, ownerId: 'vehicle-1' }),
    );
    await service.review('doc-1', ReviewDecision.REJECTED, REVIEWER, 'ilegible', NOW);
    expect(documentRejectedPayload(outbox)).toBeNull();
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

describe('DocumentsService.review · unifica ITV: aprobar el DOCUMENTO ITV registra la Inspección', () => {
  const ISSUED = new Date('2026-06-01T00:00:00.000Z');
  const itvDoc = (over: Record<string, unknown> = {}) =>
    doc({
      ownerType: FleetOwnerType.VEHICLE,
      ownerId: 'vehicle-1',
      type: FleetDocumentType.ITV,
      issuedAt: ISSUED,
      expiresAt: FUTURE,
      ...over,
    });

  it('VALIDA el doc ITV de un VEHÍCULO → createInTx en la MISMA tx: issuedAt→inspectedAt, expiresAt→nextDueAt, inspector=revisor, driverId del vehículo', async () => {
    const { service, inspections } = makeService(itvDoc());
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(inspections.createInTx).toHaveBeenCalledTimes(1);
    const [, params, inspectorId, when] = inspections.createInTx.mock.calls[0]!;
    expect(params).toMatchObject({
      vehicleId: 'vehicle-1',
      driverId: 'user-owner-1',
      passed: true,
      inspectedAt: ISSUED,
      nextDueAt: FUTURE,
    });
    expect(inspectorId).toBe(REVIEWER);
    expect(when).toBe(NOW);
  });

  it('IDEMPOTENTE: si ya existe la inspección (natural key) NO llama createInTx', async () => {
    const { service, inspections, tx } = makeService(itvDoc());
    tx.inspection.findUnique.mockResolvedValueOnce({ id: 'insp-existente' });
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(inspections.createInTx).not.toHaveBeenCalled();
  });

  it('sin issuedAt en el doc → inspectedAt cae a `now`', async () => {
    const { service, inspections } = makeService(itvDoc({ issuedAt: null }));
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    const [, params] = inspections.createInTx.mock.calls[0]!;
    expect(params.inspectedAt).toEqual(NOW);
  });

  it('un doc de VEHÍCULO que NO es ITV (SOAT) → NO crea Inspección', async () => {
    const { service, inspections } = makeService(itvDoc({ type: FleetDocumentType.SOAT }));
    await service.review('doc-1', ReviewDecision.VALID, REVIEWER, undefined, NOW);
    expect(inspections.createInTx).not.toHaveBeenCalled();
  });

  it('RECHAZAR el doc ITV → NO crea Inspección (solo VALID)', async () => {
    const { service, inspections } = makeService(itvDoc());
    await service.review('doc-1', ReviewDecision.REJECTED, REVIEWER, 'ilegible', NOW);
    expect(inspections.createInTx).not.toHaveBeenCalled();
  });
});
