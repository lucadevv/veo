/**
 * Estado en memoria del seguimiento en vivo (compartido entre el gateway Socket.IO y el
 * consumidor Kafka). Mantiene:
 *  - driverId → tripId (resuelto desde eventos trip/dispatch) para mapear ubicaciones a salas.
 *  - último estado y última ubicación por viaje (para snapshots y emisiones).
 *  - suscriptores vivos por viaje y shareId → tripId (para revocación dirigida).
 * Solo se emite a salas con tokens vivos.
 */
import { Injectable } from '@nestjs/common';
import type { GeoPoint, TripStatus } from '@veo/api-client';

export interface LiveLocation {
  point: GeoPoint;
  at: string;
}

/** Recojo y destino del viaje (para el ETA fresco por fase: pre-recojo → origin; onboard → destination). */
export interface TripPoints {
  origin: GeoPoint;
  destination: GeoPoint;
}

@Injectable()
export class RealtimeStateService {
  private readonly driverToTrip = new Map<string, string>();
  private readonly lastStatus = new Map<string, TripStatus>();
  private readonly lastLocation = new Map<string, LiveLocation>();
  private readonly subscribers = new Map<string, number>();
  private readonly socketToTrip = new Map<string, string>();
  private readonly shareToTrip = new Map<string, string>();
  // SEGURIDAD-CRÍTICA · pánico oculto: viajes con pánico activo. Mientras un tripId esté aquí, el
  // fan-out en vivo (driver:location, trip:update) hacia /family queda CORTADO (fail-safe = ocultar),
  // aunque queden sockets conectados o llegue un evento tardío. La familia cae a la vista REST
  // enmascarada (viaje "TERMINADO") en su siguiente poll. Solo se limpia al finalizar el viaje.
  private readonly panickedTrips = new Set<string>();
  // Suscriptores del namespace /passenger (separados de los de /family para no alterar su gating).
  private readonly passengerSubscribers = new Map<string, number>();
  private readonly passengerSocketToTrip = new Map<string, string>();
  private readonly lastEta = new Map<string, number | null>();
  private readonly tripPoints = new Map<string, TripPoints>();

  setDriverTrip(driverId: string, tripId: string): void {
    if (driverId) this.driverToTrip.set(driverId, tripId);
  }

  tripForDriver(driverId: string): string | undefined {
    return this.driverToTrip.get(driverId);
  }

  /**
   * Libera el mapeo de UN conductor (p. ej. el que canceló en una reasignación): su ubicación deja de
   * enrutarse al viaje. El nuevo conductor re-poblará el mapeo cuando dispatch emita el nuevo match.
   */
  clearDriver(driverId: string): void {
    if (driverId) this.driverToTrip.delete(driverId);
  }

  setStatus(tripId: string, status: TripStatus): void {
    this.lastStatus.set(tripId, status);
  }

  getStatus(tripId: string): TripStatus | undefined {
    return this.lastStatus.get(tripId);
  }

  setLocation(tripId: string, location: LiveLocation): void {
    this.lastLocation.set(tripId, location);
  }

  getLocation(tripId: string): LiveLocation | undefined {
    return this.lastLocation.get(tripId);
  }

  /** Registra una suscripción viva de un socket a un viaje (vía su token de share). */
  addSubscriber(socketId: string, tripId: string, shareId: string): void {
    this.socketToTrip.set(socketId, tripId);
    this.shareToTrip.set(shareId, tripId);
    this.subscribers.set(tripId, (this.subscribers.get(tripId) ?? 0) + 1);
  }

  /** Elimina la suscripción de un socket; devuelve el tripId que tenía (si lo tenía). */
  removeSubscriber(socketId: string): string | undefined {
    const tripId = this.socketToTrip.get(socketId);
    if (!tripId) return undefined;
    this.socketToTrip.delete(socketId);
    const next = (this.subscribers.get(tripId) ?? 1) - 1;
    if (next <= 0) this.subscribers.delete(tripId);
    else this.subscribers.set(tripId, next);
    return tripId;
  }

  /** ¿Hay al menos un token vivo escuchando este viaje? */
  isActive(tripId: string): boolean {
    return (this.subscribers.get(tripId) ?? 0) > 0;
  }

  /** Resuelve el viaje asociado a un enlace (share) con suscriptores vivos (para revocar). */
  tripForShare(shareId: string): string | undefined {
    return this.shareToTrip.get(shareId);
  }

  /**
   * SEGURIDAD-CRÍTICA · pánico oculto. Marca el viaje como en pánico: a partir de aquí NO se debe
   * emitir nada en vivo a la sala /family (fail-safe = ocultar). Idempotente.
   */
  markPanic(tripId: string): void {
    this.panickedTrips.add(tripId);
  }

  /** ¿Hay un pánico activo para este viaje? Si sí, el fan-out en vivo a /family está cortado. */
  isPanicked(tripId: string): boolean {
    return this.panickedTrips.has(tripId);
  }

  /**
   * SEGURIDAD-CRÍTICA · pánico oculto. LEVANTA la marca de pánico de un viaje: a partir de aquí el
   * fan-out en vivo a /family vuelve a fluir. Simétrico a `markPanic`, idempotente (borrar de un Set).
   *
   * Solo lo debe invocar el dominó de `panic.resolved` con status FALSE_ALARM (desenmascarado
   * conservador): un cierre RESOLVED (emergencia real) NO debe llamarlo —la máscara se mantiene porque
   * el enlace pudo ser capturado por el agresor—. La ramificación por status vive en el consumer.
   */
  clearPanic(tripId: string): void {
    this.panickedTrips.delete(tripId);
  }

  setEta(tripId: string, etaSeconds: number | null): void {
    this.lastEta.set(tripId, etaSeconds);
  }

  getEta(tripId: string): number | null {
    return this.lastEta.get(tripId) ?? null;
  }

  /** Guarda recojo/destino del viaje (los publica `trip.requested`; el destino puede reescribirse). */
  setTripPoints(tripId: string, points: TripPoints): void {
    this.tripPoints.set(tripId, points);
  }

  /** RC5 (ADR-022) · el destino se reescribió mid-trip: el ETA fresco debe apuntar al NUEVO. */
  setDestination(tripId: string, destination: GeoPoint): void {
    const points = this.tripPoints.get(tripId);
    if (points) this.tripPoints.set(tripId, { ...points, destination });
  }

  getTripPoints(tripId: string): TripPoints | undefined {
    return this.tripPoints.get(tripId);
  }

  /** Registra una suscripción viva de un pasajero (socket /passenger) a su viaje activo. */
  addPassenger(socketId: string, tripId: string): void {
    this.passengerSocketToTrip.set(socketId, tripId);
    this.passengerSubscribers.set(tripId, (this.passengerSubscribers.get(tripId) ?? 0) + 1);
  }

  /** Elimina la suscripción de un pasajero; devuelve el tripId que tenía (si lo tenía). */
  removePassenger(socketId: string): string | undefined {
    const tripId = this.passengerSocketToTrip.get(socketId);
    if (!tripId) return undefined;
    this.passengerSocketToTrip.delete(socketId);
    const next = (this.passengerSubscribers.get(tripId) ?? 1) - 1;
    if (next <= 0) this.passengerSubscribers.delete(tripId);
    else this.passengerSubscribers.set(tripId, next);
    return tripId;
  }

  /** ¿Hay al menos un pasajero conectado escuchando este viaje? */
  isPassengerActive(tripId: string): boolean {
    return (this.passengerSubscribers.get(tripId) ?? 0) > 0;
  }

  /** Limpia el estado de un viaje finalizado/cancelado. */
  clearTrip(tripId: string): void {
    this.lastStatus.delete(tripId);
    this.lastLocation.delete(tripId);
    this.lastEta.delete(tripId);
    this.tripPoints.delete(tripId);
    this.panickedTrips.delete(tripId);
    for (const [driverId, mapped] of this.driverToTrip) {
      if (mapped === tripId) this.driverToTrip.delete(driverId);
    }
  }
}
