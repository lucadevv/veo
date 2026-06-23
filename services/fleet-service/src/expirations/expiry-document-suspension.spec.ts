/**
 * Lote B · FIX 2 — AUTO-SUSPENSIÓN del conductor por DOCUMENTO crítico vencido, RE-ASSERTIVA (latch-free).
 *
 * EL BUG (asimetría con la ITV): la suspensión por documento crítico se emitía SOLO en la TRANSICIÓN de status
 * (VALID/EXPIRING_SOON → EXPIRED). Si esa emisión se PERDÍA aguas abajo (ej. el conductor aún no estaba
 * onboardeado → identity `suspendByFleet` es no-op silencioso; el evento se consumió SIN efecto), con el modelo
 * solo-en-transición NUNCA se re-emitía → el conductor quedaba SIN suspender pese al doc vencido.
 *
 * EL FIX: el path de DOCUMENTO crítico DRIVER-scoped en estado EXPIRED es ahora LATCH-FREE, igual que la ITV:
 * cada corrida del sweeper RE-EMITE `fleet.driver_suspended` mientras el doc siga EXPIRED (idempotente aguas
 * abajo — identity dedup-ea por el `@@unique([driverId, DOCUMENT_EXPIRED, docType])` del hold). NO depende de
 * la transición de status. El `fleet.document_expired` (notificación one-shot), en cambio, sigue solo-en-transición.
 *
 * Estos tests CLAVAN que:
 *   1) un doc crítico que CAE a EXPIRED (transición) emite la suspensión (keyeada por driverId de perfil = ownerId);
 *   2) un doc crítico que YA está EXPIRED (sin transición, status persistido = EXPIRED) RE-EMITE la suspensión en
 *      la corrida siguiente — el bug que cerramos: ya NO depende de la transición;
 *   3) `document_expired` (one-shot) NO se re-emite cuando no hubo transición (solo la suspensión se re-asserta);
 *   4) un doc no-crítico o VEHICLE-scoped NO suspende al conductor (no cambia esa regla).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ExpirySweeper } from './expiry.sweeper';
import { FleetEventType } from '../events/fleet-events';
import { FleetDocumentStatus, FleetDocumentType, FleetOwnerType } from '../generated/prisma';

// NOW muy posterior a expiresAt → deriveExpiryStatus = EXPIRED.
const NOW = new Date('2026-06-23T03:00:00.000Z');
const EXPIRED_AT = new Date('2026-01-01T00:00:00.000Z');

/** Documento de flota mínimo (forma que processDocument lee). */
function doc(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    ownerType: FleetOwnerType.DRIVER,
    ownerId: 'driver-profile-1', // driverId de PERFIL (el doc crítico es DRIVER-scoped, ya traducido).
    type: FleetDocumentType.SOAT, // crítico.
    expiresAt: EXPIRED_AT,
    status: FleetDocumentStatus.VALID, // estado PERSISTIDO; el sweeper deriva el nuevo desde expiresAt+now.
    lastAlertedDays: 1, // ya alertó el último hito → milestone = null (aislamos la suspensión, no las alertas).
    ...over,
  };
}

interface Harness {
  sweeper: ExpirySweeper;
  outbox: ReturnType<typeof vi.fn>;
  docUpdate: ReturnType<typeof vi.fn>;
}

function makeSweeper(docs: Record<string, unknown>[]): Harness {
  const outbox = vi.fn(async () => ({}));
  const docUpdate = vi.fn(async () => ({}));
  const tx = {
    vehicle: { update: vi.fn() },
    fleetDocument: { update: docUpdate },
    outboxEvent: { create: outbox },
  };
  // El pase documental pagina fleetDocument por cursor: la PRIMERA página (sin cursor) trae los docs; las
  // siguientes (con cursor) → [] para cortar la paginación. Keyear por la AUSENCIA de cursor (no por un
  // contador global) hace que CADA corrida del sweep vuelva a entregar los docs en su primera página.
  const prisma = {
    read: {
      fleetDocument: {
        findMany: vi.fn(async (args?: { cursor?: unknown }) => (args?.cursor ? [] : docs)),
      },
      // Aislamos el pase documental: sin vehículos → recomputeVehicles + pase de ITV no hacen nada.
      vehicle: { findMany: vi.fn(async () => []) },
      inspection: { findMany: vi.fn(async () => []) },
    },
    write: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
  const config = new ConfigService({ EXPIRY_WARNING_DAYS: 30, EXPIRY_ALERT_MILESTONES: '30,15,7,1' });
  const sweeper = new ExpirySweeper(prisma as never, config as never);
  return { sweeper, outbox, docUpdate };
}

/** Todos los payloads de un eventType encolados en el outbox. */
function payloadsOf(outbox: ReturnType<typeof vi.fn>, eventType: string): Record<string, unknown>[] {
  return outbox.mock.calls
    .filter((c) => (c[0] as { data: { eventType?: string } }).data.eventType === eventType)
    .map((c) => (c[0] as { data: { envelope: { payload: Record<string, unknown> } } }).data.envelope.payload);
}

describe('ExpirySweeper · FIX 2 · suspensión por DOCUMENTO crítico RE-ASSERTIVA (latch-free)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('TRANSICIÓN: doc crítico DRIVER que cae a EXPIRED → emite suspensión + document_expired', async () => {
    // status persistido VALID → deriva EXPIRED → statusChanged=true (transición).
    const { sweeper, outbox } = makeSweeper([doc({ status: FleetDocumentStatus.VALID })]);

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspended).toBe(1);
    const suspends = payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED);
    expect(suspends).toHaveLength(1);
    // Keyeada por driverId de PERFIL (= ownerId del doc DRIVER-scoped), NO por userId.
    expect(suspends[0]?.driverId).toBe('driver-profile-1');
    expect(suspends[0]?.documentType).toBe(FleetDocumentType.SOAT);
    // document_expired one-shot SÍ se emite en la transición.
    expect(payloadsOf(outbox, FleetEventType.DOCUMENT_EXPIRED)).toHaveLength(1);
  });

  it('RE-ASSERCIÓN (el bug): doc crítico YA EXPIRED (sin transición) → RE-EMITE la suspensión igual', async () => {
    // status persistido = EXPIRED → deriva EXPIRED → statusChanged=FALSE. Con el modelo viejo (solo-transición)
    // processDocument retornaba temprano y NO re-emitía. Ahora re-asserta: el conductor cuya suspensión se
    // perdió (no-op por onboarding tardío) vuelve a recibirla en la corrida siguiente.
    const { sweeper, outbox } = makeSweeper([doc({ status: FleetDocumentStatus.EXPIRED })]);

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspended).toBe(1);
    expect(payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED)).toHaveLength(1);
    // statusChanged=false → NO contó como cambio de status.
    expect(summary.statusChanged).toBe(0);
  });

  it('RE-ASSERCIÓN: el cron repetido RE-EMITE en CADA corrida (no solo-transición); identity dedup-ea', async () => {
    const { sweeper, outbox } = makeSweeper([doc({ status: FleetDocumentStatus.EXPIRED })]);

    const first = await sweeper.sweep(NOW);
    const second = await sweeper.sweep(NOW);

    expect(first.driversSuspended).toBe(1);
    expect(second.driversSuspended).toBe(1);
    // Dos corridas → dos suspensiones emitidas (idempotencia vive en identity, no en fleet).
    expect(payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED)).toHaveLength(2);
  });

  it('RE-ASSERCIÓN no spamea document_expired: doc YA EXPIRED → re-emite SUSPENSIÓN pero NO document_expired', async () => {
    const { sweeper, outbox, docUpdate } = makeSweeper([doc({ status: FleetDocumentStatus.EXPIRED })]);

    await sweeper.sweep(NOW);

    // La suspensión se re-asserta (idempotente en identity)...
    expect(payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED)).toHaveLength(1);
    // ...pero document_expired es one-shot (solo-transición): sin transición NO se re-emite (no spamea consumidores).
    expect(payloadsOf(outbox, FleetEventType.DOCUMENT_EXPIRED)).toHaveLength(0);
    // Y la re-asserción PURA (sin transición ni hito) NO escribe el documento (nada que persistir).
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('doc NO crítico (DNI) EXPIRED → NO suspende al conductor (no cambia la regla de criticidad)', async () => {
    const { sweeper, outbox } = makeSweeper([
      doc({ status: FleetDocumentStatus.EXPIRED, type: FleetDocumentType.DNI }),
    ]);

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspended).toBe(0);
    expect(payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED)).toHaveLength(0);
  });

  it('doc crítico pero VEHICLE-scoped EXPIRED → NO suspende al conductor (suspensión es DRIVER-scoped)', async () => {
    const { sweeper, outbox } = makeSweeper([
      doc({ status: FleetDocumentStatus.EXPIRED, ownerType: FleetOwnerType.VEHICLE, ownerId: 'veh-1' }),
    ]);

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspended).toBe(0);
    expect(payloadsOf(outbox, FleetEventType.DRIVER_SUSPENDED)).toHaveLength(0);
  });
});
