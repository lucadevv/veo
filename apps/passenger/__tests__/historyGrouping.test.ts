import type { TripResource } from '@veo/api-client';
import { groupTripsByTime } from '../src/features/trip/domain/historyGrouping';
import { calendarDaysAgo, formatTimeOfDay } from '../src/shared/utils/format';

/** Factory mínima: el agrupado solo lee `requestedAt`; el resto son valores plausibles. */
function trip(id: string, requestedAt: string): TripResource {
  return {
    id,
    passengerId: 'pax',
    driverId: 'd-1',
    vehicleId: 'v-1',
    status: 'COMPLETED',
    origin: { lat: -12.04, lon: -77.04 },
    destination: { lat: -12.1, lon: -77.0 },
    fareCents: 1500,
    currency: 'PEN',
    surgeMultiplier: 1,
    distanceMeters: 3200,
    durationSeconds: 540,
    paymentMethod: 'YAPE',
    routePolyline: null,
    childMode: false,
    penaltyCents: 0,
    requestedAt,
    completedAt: requestedAt,
    cancelledAt: null,
  } as TripResource;
}

describe('groupTripsByTime', () => {
  // Ancla fija: 2026-06-07 12:00 local.
  const now = new Date(2026, 5, 7, 12, 0, 0);

  it('agrupa en hoy / esta semana / anteriores y omite tramos vacíos', () => {
    const trips = [
      trip('today-1', new Date(2026, 5, 7, 9, 0, 0).toISOString()),
      trip('week-1', new Date(2026, 5, 4, 18, 0, 0).toISOString()), // 3 días atrás
      trip('earlier-1', new Date(2026, 4, 1, 8, 0, 0).toISOString()), // >7 días
    ];

    const sections = groupTripsByTime(trips, now);

    expect(sections.map((s) => s.id)).toEqual(['today', 'week', 'earlier']);
    expect(sections[0].data.map((t) => t.id)).toEqual(['today-1']);
    expect(sections[1].data.map((t) => t.id)).toEqual(['week-1']);
    expect(sections[2].data.map((t) => t.id)).toEqual(['earlier-1']);
  });

  it('un solo viaje de hoy produce UN header (no tres secciones vacías)', () => {
    const sections = groupTripsByTime(
      [trip('only', new Date(2026, 5, 7, 7, 30, 0).toISOString())],
      now,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe('today');
  });

  it('un viaje de las 23:00 de ayer cae en "esta semana" (compara DÍAS, no 24h)', () => {
    const sections = groupTripsByTime(
      [trip('yesterday', new Date(2026, 5, 6, 23, 0, 0).toISOString())],
      now,
    );
    expect(sections[0].id).toBe('week');
  });

  it('lista vacía → sin secciones', () => {
    expect(groupTripsByTime([], now)).toEqual([]);
  });
});

describe('calendarDaysAgo', () => {
  const now = new Date(2026, 5, 7, 12, 0, 0);

  it('hoy = 0, ayer = 1 aunque la hora sea anterior', () => {
    expect(calendarDaysAgo(new Date(2026, 5, 7, 1, 0, 0).toISOString(), now)).toBe(0);
    expect(calendarDaysAgo(new Date(2026, 5, 6, 23, 0, 0).toISOString(), now)).toBe(1);
  });

  it('fecha inválida → null', () => {
    expect(calendarDaysAgo('no-es-fecha', now)).toBeNull();
  });
});

describe('formatTimeOfDay', () => {
  it('formatea HH:mm de una fecha local', () => {
    expect(formatTimeOfDay(new Date(2026, 5, 7, 9, 4, 0).toISOString())).toBe('09:04');
  });

  it('fecha inválida → cadena vacía', () => {
    expect(formatTimeOfDay('nope')).toBe('');
  });
});
