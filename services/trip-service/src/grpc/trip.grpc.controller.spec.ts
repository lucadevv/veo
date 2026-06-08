/**
 * Tests del controlador gRPC de trip: el contrato TripReply de GetTrip/GetActiveTrip trae los campos
 * ENRIQUECIDOS del detalle de "Mis Viajes" (timestamps reales + puntos del viaje + polyline persistida),
 * que sueltan la dependencia del snapshot MMKV local de la app para la FECHA y el MAPA de ruta.
 */
import { describe, it, expect } from 'vitest';
import { TripStatus } from '@veo/shared-types';
import { TripGrpcController } from './trip.grpc.controller';
import { Prisma, type Trip } from '../generated/prisma';
import type { PrismaService } from '../infra/prisma.service';
import type { TripsService } from '../trips/trips.service';

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const now = new Date('2026-06-06T12:00:00.000Z');
  return {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    vehicleId: 'veh-1',
    originLat: -12.0464,
    originLon: -77.0428,
    destLat: -12.1219,
    destLon: -77.0297,
    waypoints: null,
    scheduledFor: null,
    activatedAt: null,
    vehicleType: 'CAR',
    dispatchMode: 'FIXED',
    requestedAt: now,
    assignedAt: null,
    acceptedAt: null,
    arrivingAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: new Date('2026-06-06T12:20:00.000Z'),
    cancelledAt: null,
    passengerClosedAt: null,
    fareCents: 1500,
    agreedFareCents: null,
    currency: 'PEN',
    surgeMultiplier: new Prisma.Decimal(1),
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'CASH',
    status: TripStatus.COMPLETED,
    routePolyline: 'abc_polyline_encoded',
    category: null,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeController(trip: Trip | null): TripGrpcController {
  const prisma = {
    read: { trip: { findUnique: async () => trip, findFirst: async () => trip } },
  } as unknown as PrismaService;
  const trips = {} as unknown as TripsService;
  return new TripGrpcController(prisma, trips);
}

describe('TripGrpcController · GetTrip (detalle "Mis Viajes" enriquecido)', () => {
  it('trae timestamps reales, puntos del viaje {lat,lng} y la polyline persistida', async () => {
    const reply = await makeController(buildTrip()).getTrip({ id: 'trip-1' });
    expect(reply.found).toBe(true);
    // Timestamps reales (ISO-8601), no el snapshot MMKV local.
    expect(reply.requestedAt).toBe('2026-06-06T12:00:00.000Z');
    expect(reply.completedAt).toBe('2026-06-06T12:20:00.000Z');
    expect(reply.cancelledAt).toBe(''); // proto3: '' → el BFF lo re-mapea a null
    // Puntos del viaje: la fila guarda lon → se expone como lng (consistencia con TripHistoryItem).
    expect(reply.originLat).toBe(-12.0464);
    expect(reply.originLng).toBe(-77.0428);
    expect(reply.destinationLat).toBe(-12.1219);
    expect(reply.destinationLng).toBe(-77.0297);
    // Ruta persistida: la app la pinta sin depender del MMKV.
    expect(reply.routePolyline).toBe('abc_polyline_encoded');
  });

  it('colapsa la polyline ausente a "" (proto3): la app degrada a línea recta origen→destino', async () => {
    const reply = await makeController(buildTrip({ routePolyline: null })).getTrip({ id: 'trip-1' });
    expect(reply.routePolyline).toBe('');
  });

  it('cancelledAt presente cuando el viaje fue cancelado; completedAt vacío', async () => {
    const reply = await makeController(
      buildTrip({
        status: TripStatus.CANCELLED_BY_PASSENGER,
        completedAt: null,
        cancelledAt: new Date('2026-06-06T12:05:00.000Z'),
      }),
    ).getTrip({ id: 'trip-1' });
    expect(reply.completedAt).toBe('');
    expect(reply.cancelledAt).toBe('2026-06-06T12:05:00.000Z');
  });

  it('viaje inexistente → found=false con los campos nuevos vacíos (EMPTY_TRIP)', async () => {
    const reply = await makeController(null).getTrip({ id: 'nope' });
    expect(reply.found).toBe(false);
    expect(reply.requestedAt).toBe('');
    expect(reply.routePolyline).toBe('');
    expect(reply.originLat).toBe(0);
  });
});
