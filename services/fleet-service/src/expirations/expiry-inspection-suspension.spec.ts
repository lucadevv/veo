/**
 * Lote B · AUTO-SUSPENSIÓN del conductor por INSPECCIÓN técnica (ITV) vencida del vehículo OPERADO.
 *
 * EL FILO (bug a evitar): `Vehicle.driverId` = **User.id**, pero la suspensión del conductor en identity
 * espera el **Driver.id de PERFIL**. El sweeper NO traduce: emite el evento keyeado por `userId` (User.id)
 * y identity resuelve User.id → Driver.id en SU consumer. Estos tests CLAVAN que:
 *   1) una ITV vencida del vehículo operado emite la suspensión keyeada por `userId` (NUNCA driverId);
 *   2) IDEMPOTENCIA por HOLDS (sin latch local): el sweeper RE-EMITE en cada corrida si la ITV sigue vencida
 *      — ya no hay un latch `inspectionSuspendedAt` que filtre/deduplique en fleet. La idempotencia la garantiza
 *      identity (el `@@unique` del hold INSPECTION_EXPIRED hace que re-recibir la misma causa sea un no-op);
 *   3) un conductor SIN inspección queda grandfathered (no se toca);
 *   4) reusa pickActiveVehicle + isInspectionCurrent (consistente con el gate, sin redefinir la regla):
 *      una inspección VIGENTE no suspende; una REPROBADA (passed=false) sí.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { domainEventsTotal } from '@veo/observability';
import { ExpirySweeper } from './expiry.sweeper';
import { FleetEventType } from '../events/fleet-events';
import { VehicleDocStatus } from '../generated/prisma';

const NOW = new Date('2026-06-23T03:00:00.000Z');

/** Vehículo mínimo con los campos que pickActiveVehicle + el pase de ITV leen. */
function vehicle(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'veh-1',
    plate: 'ABC-123',
    driverId: 'user-1', // User.id (NO el id de perfil Driver) — el filo del lote.
    docStatus: VehicleDocStatus.VALID,
    selectedAt: new Date('2026-06-10T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

/** Inspección mínima (forma que isInspectionCurrent + el payload leen). */
function inspection(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'insp-1',
    vehicleId: 'veh-1',
    passed: true,
    nextDueAt: new Date('2026-09-10T00:00:00.000Z'),
    inspectedAt: new Date('2026-06-10T00:00:00.000Z'),
    ...over,
  };
}

interface Scenario {
  /** Vehículos que el pase de ITV pagina (where driverId!=null). SIN filtro de latch (eliminado). */
  vehiclesForSweep: Record<string, unknown>[];
  /** Todos los vehículos del conductor (la 2da query, where driverId=userId). */
  vehiclesForDriver: Record<string, unknown>[];
  /** Última inspección del vehículo operado (orderBy inspectedAt desc) — null = sin inspección. */
  latestInspection: Record<string, unknown> | null;
}

interface Harness {
  sweeper: ExpirySweeper;
  outbox: ReturnType<typeof vi.fn>;
}

function makeSweeper(s: Scenario): Harness {
  const outbox = vi.fn(async () => ({}));

  // findMany de vehicle: 1ra llamada = pase de ITV (select id,driverId); 2da = vehículos del conductor.
  let vehicleCalls = 0;
  const vehicleFindMany = vi.fn(async () => {
    vehicleCalls += 1;
    return vehicleCalls === 1 ? s.vehiclesForSweep : s.vehiclesForDriver;
  });

  // SIN latch: el sweeper ya no hace CAS sobre vehicle.updateMany; la suspensión por ITV solo encola el evento.
  const tx = {
    vehicle: { update: vi.fn() },
    fleetDocument: { update: vi.fn() },
    outboxEvent: { create: outbox },
  };

  const prisma = {
    read: {
      // Pase documental: sin documentos → no-op (aislamos el pase de ITV).
      fleetDocument: { findMany: vi.fn(async () => []) },
      vehicle: { findMany: vehicleFindMany },
      // FIX N+1: el pase de ITV ahora batchea las inspecciones (findMany con orderBy desc), no findFirst por
      // conductor. El doble devuelve [latest] (o [] si null); el service se queda con la primera por vehículo.
      inspection: { findMany: vi.fn(async () => (s.latestInspection ? [s.latestInspection] : [])) },
    },
    write: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };

  const config = new ConfigService({
    EXPIRY_WARNING_DAYS: 30,
    EXPIRY_ALERT_MILESTONES: '30,15,7,1',
  });

  const sweeper = new ExpirySweeper(prisma as never, config as never);
  return { sweeper, outbox };
}

/**
 * Extrae el payload DRIVER_SUSPENDED del envelope encolado en el outbox (o null si no hubo). El enqueue
 * llama `outboxEvent.create({ data: { aggregateId, eventType, envelope } })`, así que el arg es `{ data }`.
 */
function suspendedPayload(outbox: ReturnType<typeof vi.fn>): Record<string, unknown> | null {
  const call = outbox.mock.calls.find(
    (c) =>
      (c[0] as { data: { eventType?: string } }).data.eventType === FleetEventType.DRIVER_SUSPENDED,
  );
  if (!call) return null;
  return (call[0] as { data: { envelope: { payload: Record<string, unknown> } } }).data.envelope
    .payload;
}

describe('ExpirySweeper · auto-suspensión por ITV vencida (Lote B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ITV VENCIDA del vehículo operado → suspende keyeado por userId (NO por driverId de perfil)', async () => {
    const veh = vehicle();
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      // Última inspección VENCIDA: nextDueAt < NOW.
      latestInspection: inspection({ nextDueAt: new Date('2026-05-01T00:00:00.000Z') }),
    });

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(1);
    const payload = suspendedPayload(outbox);
    expect(payload).not.toBeNull();
    // EL FILO: el sujeto viaja por `userId` (User.id), NO por `driverId` (id de perfil). Mandar el User.id
    // en `driverId` suspendería al conductor EQUIVOCADO — este assert lo impide para siempre.
    expect(payload?.userId).toBe('user-1');
    expect(payload?.driverId).toBeUndefined();
    expect(payload?.reason).toBe('Inspección técnica (ITV) vencida');
    expect(payload?.vehicleId).toBe('veh-1');
    expect(payload?.inspectionId).toBe('insp-1');
  });

  it('inspección REPROBADA (passed=false) post-aprobación → suspende (perdió la ITV)', async () => {
    const veh = vehicle();
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      // Vigente por fecha PERO reprobada: isInspectionCurrent = false → suspende.
      latestInspection: inspection({ passed: false }),
    });

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(1);
    expect(suspendedPayload(outbox)?.userId).toBe('user-1');
  });

  it('idempotencia por HOLDS (sin latch): el cron repetido RE-EMITE si la ITV sigue vencida → identity dedup-ea', async () => {
    // Sin latch local, el sweeper re-evalúa y RE-EMITE en cada corrida; la idempotencia ahora vive en identity
    // (el `@@unique` del hold INSPECTION_EXPIRED colapsa la re-recepción a un no-op). Acá clavamos que fleet
    // re-emite — que es exactamente lo que habilita al conductor reactivado a mano a volver a ser suspendible.
    const veh = vehicle();
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      latestInspection: inspection({ nextDueAt: new Date('2026-05-01T00:00:00.000Z') }),
    });

    const first = await sweeper.sweep(NOW);
    const second = await sweeper.sweep(NOW);

    // Cada corrida cuenta y emite (no hay filtro de latch que la frene); identity dedup-ea aguas abajo.
    expect(first.driversSuspendedByInspection).toBe(1);
    expect(second.driversSuspendedByInspection).toBe(1);
    expect(suspendedPayload(outbox)?.userId).toBe('user-1');
  });

  it('grandfather: conductor SIN inspección en archivo → NO se suspende', async () => {
    const veh = vehicle();
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      latestInspection: null, // nunca tuvo ITV: no hay vencimiento que procesar.
    });

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(0);
    expect(suspendedPayload(outbox)).toBeNull();
  });

  it('ITV VIGENTE (passed && nextDueAt > now) → NO suspende (reusa isInspectionCurrent del gate)', async () => {
    const veh = vehicle();
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      latestInspection: inspection({ nextDueAt: new Date('2026-09-10T00:00:00.000Z') }),
    });

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(0);
    expect(suspendedPayload(outbox)).toBeNull();
  });

  it('FIX N+1: dos conductores con ITV vencida se resuelven con UNA query de inspecciones (batch), no N+1', async () => {
    const vehA = vehicle({ id: 'veh-A', driverId: 'user-A' });
    const vehB = vehicle({ id: 'veh-B', driverId: 'user-B' });
    const inspA = inspection({ id: 'insp-A', vehicleId: 'veh-A', nextDueAt: new Date('2026-05-01T00:00:00.000Z') });
    const inspB = inspection({ id: 'insp-B', vehicleId: 'veh-B', nextDueAt: new Date('2026-05-01T00:00:00.000Z') });

    const outbox = vi.fn(async (_args?: { data: Record<string, unknown> }) => ({}));
    const tx = {
      vehicle: { update: vi.fn() },
      fleetDocument: { update: vi.fn() },
      outboxEvent: { create: outbox },
    };
    // 1ra vehicle.findMany = pase (ambos vehículos); 2da = batch de todos los vehículos del lote.
    const vehicleFindMany = vi.fn(async (_args?: Record<string, unknown>) => [vehA, vehB]);
    const inspectionFindMany = vi.fn(async (_args?: Record<string, unknown>) => [inspA, inspB]);
    const prisma = {
      read: {
        fleetDocument: { findMany: vi.fn(async () => []) },
        vehicle: { findMany: vehicleFindMany },
        inspection: { findMany: inspectionFindMany },
      },
      write: { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) },
    };
    const config = new ConfigService({ EXPIRY_WARNING_DAYS: 30, EXPIRY_ALERT_MILESTONES: '30,15,7,1' });
    const sweeper = new ExpirySweeper(prisma as never, config as never);

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(2);
    // EL FIX: UNA sola query de inspecciones para los DOS conductores (batch), no una por conductor (N+1).
    expect(inspectionFindMany).toHaveBeenCalledTimes(1);
    expect(inspectionFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { vehicleId: { in: expect.arrayContaining(['veh-A', 'veh-B']) } },
    });
    // Ambos conductores keyeados por su userId (nunca driverId de perfil).
    const userIds = outbox.mock.calls
      .map(
        (c) =>
          (c[0] as { data: { envelope: { payload: { userId?: string } } } } | undefined)?.data
            .envelope.payload.userId,
      )
      .filter(Boolean);
    expect(userIds).toEqual(expect.arrayContaining(['user-A', 'user-B']));
  });

  it('FIX observabilidad: cada suspensión por ITV bumpea domain_events_total{event=fleet.driver_suspended}', async () => {
    const labels = { event: FleetEventType.DRIVER_SUSPENDED, result: 'emitted' };
    const before = (await domainEventsTotal.get()).values.find(
      (v) => v.labels.event === labels.event && v.labels.result === labels.result,
    )?.value ?? 0;

    const veh = vehicle();
    const { sweeper } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      latestInspection: inspection({ nextDueAt: new Date('2026-05-01T00:00:00.000Z') }),
    });
    await sweeper.sweep(NOW);

    const after = (await domainEventsTotal.get()).values.find(
      (v) => v.labels.event === labels.event && v.labels.result === labels.result,
    )?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('sin vehículo OPERABLE (todos con docs vencidos) → NO suspende por ITV (lo cubre el gate de alta)', async () => {
    // El vehículo aparece en el pase (where driverId!=null) pero pickActiveVehicle lo descarta por docStatus
    // EXPIRED → no hay vehículo operado que evaluar.
    const veh = vehicle({ docStatus: VehicleDocStatus.EXPIRED });
    const { sweeper, outbox } = makeSweeper({
      vehiclesForSweep: [veh],
      vehiclesForDriver: [veh],
      latestInspection: inspection({ nextDueAt: new Date('2026-05-01T00:00:00.000Z') }),
    });

    const summary = await sweeper.sweep(NOW);

    expect(summary.driversSuspendedByInspection).toBe(0);
    expect(suspendedPayload(outbox)).toBeNull();
  });
});
