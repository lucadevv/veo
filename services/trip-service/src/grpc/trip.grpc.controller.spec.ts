/**
 * Tests del controlador gRPC de trip: el contrato TripReply de GetTrip/GetActiveTrip trae los campos
 * ENRIQUECIDOS del detalle de "Mis Viajes" (timestamps reales + puntos del viaje + polyline persistida),
 * que sueltan la dependencia del snapshot MMKV local de la app para la FECHA y el MAPA de ruta.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Metadata } from '@grpc/grpc-js';
import { TripStatus } from '@veo/shared-types';
import {
  signInternalIdentity,
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  type AuthenticatedUser,
} from '@veo/auth';
import type { ConfigService } from '@nestjs/config';
import { TripGrpcController } from './trip.grpc.controller';
import { Prisma, type Trip } from '../generated/prisma';
import type { PrismaService } from '../infra/prisma.service';
import type { TripsService } from '../trips/trips.service';
import type { TripQueryService } from '../trips/trip-query.service';
import type { Env } from '../config/env.schema';

const SECRET = 'test-internal-secret';
const config = { get: () => SECRET } as unknown as ConfigService<Env, true>;

/** Metadata gRPC con la identidad interna FIRMADA (lo que el BFF propaga). */
function signedMeta(user: AuthenticatedUser): Metadata {
  const { header, signature } = signInternalIdentity(user, SECRET);
  const map: Record<string, string> = {
    [INTERNAL_IDENTITY_HEADER]: header,
    [INTERNAL_IDENTITY_SIG_HEADER]: signature,
  };
  return { get: (k: string) => (map[k] !== undefined ? [map[k]] : []) } as unknown as Metadata;
}
const emptyMeta = { get: () => [] } as unknown as Metadata;

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

function makeController(trip: Trip | null, trips: Partial<TripsService> = {}): TripGrpcController {
  const prisma = {
    read: { trip: { findUnique: async () => trip, findFirst: async () => trip } },
  } as unknown as PrismaService;
  const query = {} as unknown as TripQueryService;
  return new TripGrpcController(prisma, trips as TripsService, query, config);
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
    const reply = await makeController(buildTrip({ routePolyline: null })).getTrip({
      id: 'trip-1',
    });
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

describe('TripGrpcController · CloseTripByPassenger (anti-IDOR: identidad FIRMADA, no el payload)', () => {
  const view = {
    id: 'trip-1',
    passengerId: 'pax-real',
    driverId: 'drv-1',
    vehicleId: 'veh-1',
    status: TripStatus.COMPLETED,
    fareCents: 1500,
    currency: 'PEN',
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'CASH',
    childMode: false,
    penaltyCents: 0,
    vehicleType: 'CAR',
    scheduledFor: null,
    passengerClosedAt: '2026-06-06T12:30:00.000Z',
    requestedAt: '2026-06-06T12:00:00.000Z',
    completedAt: '2026-06-06T12:20:00.000Z',
    cancelledAt: null,
    origin: { lat: -12.0464, lon: -77.0428 },
    destination: { lat: -12.1219, lon: -77.0297 },
    routePolyline: null,
  };

  it('rechaza UNAUTHENTICATED si falta la identidad firmada en la metadata (no intenta cerrar)', async () => {
    const closeByPassenger = vi.fn();
    const ctrl = makeController(null, { closeByPassenger });
    await expect(
      ctrl.closeTripByPassenger({ id: 'trip-1', passengerId: 'pax-forjado' }, emptyMeta),
    ).rejects.toThrow(/Identidad interna/);
    expect(closeByPassenger).not.toHaveBeenCalled();
  });

  it('cierra con el userId de la identidad FIRMADA, IGNORANDO el passengerId del payload (forjado)', async () => {
    const closeByPassenger = vi.fn().mockResolvedValue(view as never);
    const ctrl = makeController(null, { closeByPassenger });
    const meta = signedMeta({ userId: 'pax-real', type: 'passenger', roles: [], sessionId: 's1' });

    const reply = await ctrl.closeTripByPassenger(
      { id: 'trip-1', passengerId: 'pax-FORJADO' },
      meta,
    );

    // El dueño es el de la firma (pax-real), NO el del cuerpo (pax-FORJADO) → un payload falsificado no cierra ajenos.
    expect(closeByPassenger).toHaveBeenCalledWith('trip-1', 'pax-real');
    expect(reply.found).toBe(true);
  });
});
