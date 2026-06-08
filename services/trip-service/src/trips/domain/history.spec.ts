/**
 * Historial paginado del pasajero (helpers PUROS del dominio): codec del cursor, where keyset, mapper.
 * La paginación end-to-end (peek + nextCursor) se testea contra TripsService en trips.history.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  historyWhere,
  tripToHistoryItem,
  DEFAULT_HISTORY_PAGE,
  MAX_HISTORY_PAGE,
} from './history';
import type { Trip } from '../../generated/prisma';

describe('history · clampLimit', () => {
  it('default cuando no hay limit o es 0/negativo', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampLimit(0)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampLimit(-5)).toBe(DEFAULT_HISTORY_PAGE);
  });

  it('acota al tope MAX_HISTORY_PAGE (anti páginas enormes)', () => {
    expect(clampLimit(10_000)).toBe(MAX_HISTORY_PAGE);
    expect(clampLimit(MAX_HISTORY_PAGE + 1)).toBe(MAX_HISTORY_PAGE);
  });

  it('respeta un limit válido (y trunca decimales)', () => {
    expect(clampLimit(7)).toBe(7);
    expect(clampLimit(7.9)).toBe(7);
  });
});

describe('history · cursor codec (opaco, round-trip)', () => {
  it('encode→decode preserva requestedAt + id', () => {
    const c = { requestedAt: '2026-06-01T10:00:00.000Z', id: 'trip-abc' };
    const token = encodeCursor(c);
    // Opaco: no es legible a simple vista (base64url).
    expect(token).not.toContain('|');
    expect(decodeCursor(token)).toEqual(c);
  });

  it('cursor inválido/malformado → null (se trata como primera página, no 500)', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64-!!!')).toBeNull();
    // base64 de algo sin separador o con fecha basura → null.
    expect(decodeCursor(Buffer.from('sinpipe', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('fecha-mala|id', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('history · historyWhere (keyset)', () => {
  it('sin cursor → solo filtra por pasajero (primera página)', () => {
    expect(historyWhere('pax-1', null)).toEqual({ passengerId: 'pax-1' });
  });

  it('con cursor → OR (requestedAt < cursor) o (== y id <) — y SIEMPRE el passengerId (anti-IDOR)', () => {
    const at = '2026-06-01T10:00:00.000Z';
    const where = historyWhere('pax-1', { requestedAt: at, id: 'trip-9' });
    expect(where.passengerId).toBe('pax-1');
    expect(where.OR).toEqual([
      { requestedAt: { lt: new Date(at) } },
      { requestedAt: new Date(at), id: { lt: 'trip-9' } },
    ]);
  });
});

describe('history · tripToHistoryItem', () => {
  const base: Trip = {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    vehicleId: 'veh-1',
    originLat: -12.04,
    originLon: -77.04,
    destLat: -12.12,
    destLon: -77.02,
    waypoints: null,
    scheduledFor: null,
    activatedAt: null,
    vehicleType: 'MOTO',
    dispatchMode: 'FIXED',
    requestedAt: new Date('2026-06-01T10:00:00.000Z'),
    assignedAt: null,
    acceptedAt: null,
    arrivingAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: new Date('2026-06-01T10:30:00.000Z'),
    cancelledAt: null,
    passengerClosedAt: null,
    fareCents: 1500,
    agreedFareCents: null,
    currency: 'PEN',
    surgeMultiplier: { toString: () => '1' } as never,
    distanceMeters: 4200,
    durationSeconds: 900,
    paymentMethod: 'CASH',
    status: 'COMPLETED',
    routePolyline: null,
    category: 'veo_economico',
    childMode: false,
    childCodeHash: null,
    promoCode: null,
    specialRequests: [],
    cancelledBy: null,
    cancellationReason: null,
    penaltyCents: 0,
    reassignCount: 0,
    negotiationSeq: 0,
    idempotencyKey: null,
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    updatedAt: new Date('2026-06-01T10:30:00.000Z'),
  };

  it('mapea con estado real, ruta lat/lng, fechas ISO, y SIN nombre de conductor (solo driverId)', () => {
    const item = tripToHistoryItem(base);
    expect(item).toMatchObject({
      id: 'trip-1',
      status: 'COMPLETED',
      origin: { lat: -12.04, lng: -77.04 },
      destination: { lat: -12.12, lng: -77.02 },
      fareCents: 1500,
      currency: 'PEN',
      paymentMethod: 'CASH',
      distanceMeters: 4200,
      durationSeconds: 900,
      requestedAt: '2026-06-01T10:00:00.000Z',
      completedAt: '2026-06-01T10:30:00.000Z',
      cancelledAt: null,
      driverId: 'drv-1',
      vehicleType: 'MOTO',
      category: 'veo_economico',
    });
    // anti-N+1: el item no expone nombre del conductor.
    expect(item).not.toHaveProperty('driverName');
  });

  it('viaje sin conductor (EXPIRED) → driverId null', () => {
    const item = tripToHistoryItem({ ...base, driverId: null, status: 'EXPIRED', completedAt: null });
    expect(item.driverId).toBeNull();
    expect(item.completedAt).toBeNull();
    expect(item.status).toBe('EXPIRED');
  });
});
