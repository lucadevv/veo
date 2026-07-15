/**
 * IncentivesService.listForDriver — el conductor NO debe ver incentivos HORA_PICO mientras su multiplicador NO
 * se pague (ningún camino de plata lo consume). Mostrarlo sería una "promesa sin pago". Se des-oculta cuando el
 * payout implemente el multiplicador. (Gate auditar-core · MEDIA #12, decisión del dueño: quitar la promesa.)
 */
import { describe, it, expect, vi } from 'vitest';
import { IncentivesService } from './incentives.service';
import type { IncentivesRepository } from './incentives.repository';

type Row = Record<string, unknown>;

function makeIncentive(id: string, type: 'META_VIAJES' | 'HORA_PICO'): Row {
  return {
    id,
    type,
    title: `inc-${id}`,
    description: 'desc',
    targetTrips: type === 'META_VIAJES' ? 20 : 0,
    rewardCents: type === 'META_VIAJES' ? 6000 : 0,
    multiplierBps: type === 'HORA_PICO' ? 12000 : 0,
    active: true,
    startsAt: null, // sin ventana → siempre activo (isActiveAt)
    endsAt: null,
    peakStartMinute: null,
    peakEndMinute: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('IncentivesService.listForDriver · HORA_PICO oculto (multiplicador aún no pagado)', () => {
  it('NO devuelve incentivos HORA_PICO; sí los META_VIAJES (ninguna promesa de multiplicador sin pago)', async () => {
    const incentives = [makeIncentive('meta', 'META_VIAJES'), makeIncentive('peak', 'HORA_PICO')];
    // Se MOCKEA EL REPO (seam de acceso a datos), no Prisma: el filtro HORA_PICO es del service.
    const repo = {
      findActiveIncentives: vi.fn(async () => incentives),
      findProgressForDriver: vi.fn(async () => []),
    } as unknown as IncentivesRepository;

    const out = await new IncentivesService(repo).listForDriver('drv-1');

    expect(out.map((v) => v.type)).toEqual(['META_VIAJES']); // HORA_PICO filtrado del listado
    expect(out.every((v) => v.multiplierBps === 0)).toBe(true); // ningún +% se muestra al conductor
  });
});
