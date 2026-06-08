/**
 * Cliente Socket.IO del conductor (namespace /driver del driver-bff).
 * Hace lo que hace la app del conductor en el golden path:
 *   - handshake con Bearer (JWT de conductor),
 *   - publica `location` (→ driver-bff publica driver.location_updated a Kafka → dispatch hot index),
 *   - escucha `dispatch:offer` (el match que dispatch entrega por el outbox→Kafka→BFF).
 */
import { io, type Socket } from 'socket.io-client';
import { BASE_URLS } from './config.js';

export interface DispatchOfferEvent {
  tripId: string;
  driverId: string;
  matchId: string;
  expiresAt?: string;
}

/**
 * Sobre que emite el driver-bff por `dispatch:offer`: el payload del evento `dispatch.offered`
 * viene ANIDADO bajo `.payload` (junto a eventType/occurredAt). Lo desempaquetamos.
 */
interface OfferEnvelope {
  eventType?: string;
  occurredAt?: string;
  payload?: DispatchOfferEvent;
}

export class DriverSocket {
  private socket?: Socket;
  private readonly offers: DispatchOfferEvent[] = [];
  private offerWaiter?: (o: DispatchOfferEvent) => void;

  constructor(private readonly token: string) {}

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = io(`${BASE_URLS.driverBff}/driver`, {
        transports: ['websocket'],
        auth: { token: this.token },
        reconnection: false,
        timeout: timeoutMs,
      });
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('timeout conectando /driver socket')), timeoutMs);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`connect_error /driver: ${err.message}`));
      });
      socket.on('dispatch:offer', (envelope: OfferEnvelope) => {
        const offer = envelope.payload;
        if (!offer) return;
        this.offers.push(offer);
        if (this.offerWaiter) {
          this.offerWaiter(offer);
          this.offerWaiter = undefined;
        }
      });
    });
  }

  /** Publica un reporte de ubicación y espera el ack del servidor. */
  publishLocation(report: {
    lat: number;
    lon: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
    /** ISO-8601; el schema driverLocationReport exige `ts` como string. */
    ts?: string;
    vehicleType?: 'CAR' | 'MOTO';
  }): Promise<{ ok: boolean; error?: string }> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('socket no conectado'));
    const body = {
      lat: report.lat,
      lon: report.lon,
      heading: report.heading ?? 0,
      speed: report.speed ?? 0,
      accuracy: report.accuracy ?? 5,
      ts: report.ts ?? new Date().toISOString(),
      ...(report.vehicleType ? { vehicleType: report.vehicleType } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ack location')), 5000);
      socket.emit('location', body, (ack: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  /** Espera la oferta de dispatch (ya recibida o futura). */
  waitForOffer(timeoutMs: number): Promise<DispatchOfferEvent> {
    const existing = this.offers[0];
    if (existing) return Promise.resolve(existing);
    return new Promise<DispatchOfferEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offerWaiter = undefined;
        reject(new Error(`timeout esperando dispatch:offer (${timeoutMs}ms)`));
      }, timeoutMs);
      this.offerWaiter = (o): void => {
        clearTimeout(timer);
        resolve(o);
      };
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}
