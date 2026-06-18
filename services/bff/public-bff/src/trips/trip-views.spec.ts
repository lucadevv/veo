/** Tests de los mappers/agregadores de viajes (puros, sin I/O). */
import { describe, it, expect } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import { buildDriverView, buildTripDetail, buildVehicleView, toTripStatus } from './trip-views';
import type { AggregateReply, DriverReply, TripReply, VehicleReply } from '../infra/grpc-types';

const driver: DriverReply = {
  id: 'drv-1',
  userId: 'usr-1',
  currentStatus: 'ONLINE',
  backgroundCheckStatus: 'APPROVED',
  averageRating: 4.2,
  found: true,
  suspendedAt: '',
  name: 'Khalid Ríos',
  rejectionReason: '',
  licenseNumber: '',
  kycStatus: '',
  createdAt: '',
  faceEnrolledAt: '',
  lastVerifiedAt: '',
  phone: '',
};

const aggregate: AggregateReply = {
  subjectId: 'drv-1',
  role: 'DRIVER',
  rollingAvg30d: 4.8,
  count30d: 25,
  flagged: false,
  flagReason: '',
  lastComputedAt: '2026-05-01T00:00:00.000Z',
  found: true,
};

const vehicle: VehicleReply = {
  id: 'veh-1',
  plate: 'ABC-123',
  make: 'Toyota',
  model: 'Yaris',
  year: 2021,
  color: 'Blanco',
  docStatus: 'OK',
  active: true,
  found: true,
  vehicleType: 'CAR',
  status: 'ACTIVE',
};

const trip: TripReply = {
  id: 'trip-1',
  passengerId: 'pax-1',
  driverId: 'drv-1',
  vehicleId: 'veh-1',
  status: 'IN_PROGRESS',
  fareCents: 1500,
  currency: 'PEN',
  distanceMeters: 4200,
  durationSeconds: 900,
  paymentMethod: 'CASH',
  childMode: false,
  penaltyCents: 0,
  passengerClosedAt: '',
  requestedAt: '2026-06-06T10:00:00.000Z',
  completedAt: '2026-06-06T10:15:00.000Z',
  cancelledAt: '',
  originLat: -12.0464,
  originLng: -77.0428,
  destinationLat: -12.05,
  destinationLng: -77.05,
  routePolyline: 'abc_polyline_encoded',
  waypoints: [
    { lat: -12.048, lon: -77.043 },
    { lat: -12.049, lon: -77.046 },
  ],
  found: true,
};

describe('toTripStatus', () => {
  it('normaliza un estado válido', () => {
    expect(toTripStatus('ACCEPTED')).toBe('ACCEPTED');
  });
  it('lanza ExternalServiceError ante un estado desconocido', () => {
    expect(() => toTripStatus('WAT')).toThrow(ExternalServiceError);
  });
  it('colapsa CANCELLED_BY_PASSENGER → CANCELLED (alias dominio→mobile)', () => {
    expect(toTripStatus('CANCELLED_BY_PASSENGER')).toBe('CANCELLED');
  });
  it('colapsa CANCELLED_BY_DRIVER → CANCELLED (sin esto, GET /trips/:id tiraba 5xx)', () => {
    expect(toTripStatus('CANCELLED_BY_DRIVER')).toBe('CANCELLED');
  });
});

describe('buildDriverView', () => {
  it('prefiere el rolling 30d cuando hay muestras', () => {
    expect(buildDriverView(driver, aggregate)?.rating).toBe(4.8);
  });
  it('cae al promedio del conductor si el agregado no tiene muestras', () => {
    const view = buildDriverView(driver, { ...aggregate, count30d: 0 });
    expect(view?.rating).toBe(4.2);
    expect(view?.ratingCount).toBe(0);
  });
  it('rating null si no hay datos', () => {
    const view = buildDriverView({ ...driver, averageRating: 0 }, null);
    expect(view?.rating).toBeNull();
  });
  it('null si no hay conductor', () => {
    expect(buildDriverView(null, aggregate)).toBeNull();
  });
});

describe('buildVehicleView', () => {
  it('mapea los campos del vehículo', () => {
    expect(buildVehicleView(vehicle)).toMatchObject({ plate: 'ABC-123', model: 'Yaris' });
  });
  it('null si no hay vehículo', () => {
    expect(buildVehicleView(null)).toBeNull();
  });
});

describe('buildTripDetail', () => {
  it('agrega viaje + conductor + rating + vehículo', () => {
    const view = buildTripDetail(trip, driver, aggregate, vehicle);
    expect(view.id).toBe('trip-1');
    expect(view.status).toBe('IN_PROGRESS');
    expect(view.driver?.rating).toBe(4.8);
    expect(view.vehicle?.plate).toBe('ABC-123');
    // proto3 '' → null en la vista mobile.
    expect(view.passengerClosedAt).toBeNull();
    // myRatingStars por defecto null (no enriquecido): la app aún no califica este viaje.
    expect(view.myRatingStars).toBeNull();
  });

  it('incluye myRatingStars cuando el pasajero ya calificó (enriquecido)', () => {
    const view = buildTripDetail(trip, driver, aggregate, vehicle, 0, 5);
    expect(view.myRatingStars).toBe(5);
  });

  it('myRatingStars null cuando el pasajero todavía no calificó', () => {
    const view = buildTripDetail(trip, driver, aggregate, vehicle, 0, null);
    expect(view.myRatingStars).toBeNull();
  });

  it('re-mapea passengerClosedAt ISO del gRPC a la vista (viaje ya cerrado)', () => {
    const sealedAt = '2026-06-06T12:00:00.000Z';
    const view = buildTripDetail({ ...trip, passengerClosedAt: sealedAt }, null, null, null);
    expect(view.passengerClosedAt).toBe(sealedAt);
  });
  it('soporta viaje sin conductor/vehículo asignado', () => {
    const view = buildTripDetail(trip, null, null, null);
    expect(view.driver).toBeNull();
    expect(view.vehicle).toBeNull();
  });

  it('enriquece "Mis Viajes": timestamps, puntos {lat,lng} y polyline (suelta el snapshot MMKV)', () => {
    const view = buildTripDetail(trip, driver, aggregate, vehicle);
    expect(view.requestedAt).toBe('2026-06-06T10:00:00.000Z');
    expect(view.completedAt).toBe('2026-06-06T10:15:00.000Z');
    expect(view.origin).toEqual({ lat: -12.0464, lng: -77.0428 });
    expect(view.destination).toEqual({ lat: -12.05, lng: -77.05 });
    expect(view.routePolyline).toBe('abc_polyline_encoded');
    // Fuente única (§5-bis): las paradas del trip del servidor van en la vista, intactas y ordenadas.
    expect(view.waypoints).toEqual([
      { lat: -12.048, lon: -77.043 },
      { lat: -12.049, lon: -77.046 },
    ]);
  });

  it('viaje directo: sin paradas del servidor → waypoints [] (degradación honesta, no crash)', () => {
    const view = buildTripDetail({ ...trip, waypoints: [] }, null, null, null);
    expect(view.waypoints).toEqual([]);
  });

  it('re-mapea los opcionales vacíos del gRPC (proto3 "" → null) null-safe', () => {
    const view = buildTripDetail(
      { ...trip, completedAt: '', cancelledAt: '', routePolyline: '' },
      null,
      null,
      null,
    );
    expect(view.completedAt).toBeNull();
    expect(view.cancelledAt).toBeNull();
    // Sin polyline persistida: la app degrada a línea recta origen→destino.
    expect(view.routePolyline).toBeNull();
    // requestedAt SIEMPRE presente (no nullable).
    expect(view.requestedAt).toBe('2026-06-06T10:00:00.000Z');
  });
});
