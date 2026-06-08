import { describe, it, expect } from 'vitest';
import { tripRecordToSummary, driverRecordToSummary, mapTripStatus } from './mappers';
import type { TripRecord, DriverRecord } from '../read-model/read-model.service';

describe('mappers OPS', () => {
  it('mapea TripRecord → tripSummary preservando céntimos e id', () => {
    const rec: TripRecord = {
      id: 't1',
      status: 'IN_PROGRESS',
      passengerId: 'p1',
      driverId: 'd1',
      fareCents: 1500,
      createdAt: '2026-05-29T00:00:00.000Z',
    };
    expect(tripRecordToSummary(rec)).toEqual({
      id: 't1',
      status: 'IN_PROGRESS',
      passengerId: 'p1',
      driverId: 'd1',
      fareCents: 1500,
      createdAt: '2026-05-29T00:00:00.000Z',
    });
  });

  it('mapea DriverRecord → driverSummary con rating nullable', () => {
    const rec: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'ACTIVE',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
      updatedAt: '2026-05-29T00:00:00.000Z',
    };
    expect(driverRecordToSummary(rec)).toEqual({
      id: 'd1',
      userId: 'u1',
      status: 'ACTIVE',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
    });
  });

  it('normaliza estados de trip-service al enum de la vista', () => {
    expect(mapTripStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(mapTripStatus('CANCELLED_BY_PASSENGER')).toBe('CANCELLED');
    expect(mapTripStatus('CANCELLED_BY_DRIVER')).toBe('CANCELLED');
    expect(mapTripStatus('EXPIRED')).toBe('CANCELLED');
    expect(mapTripStatus('FAILED')).toBe('CANCELLED');
    expect(mapTripStatus('ALGO_RARO')).toBe('REQUESTED');
  });
});
