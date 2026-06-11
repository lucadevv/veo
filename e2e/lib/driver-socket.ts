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

/** Propina recibida en vivo (payment.tip_added → driver-bff → `payment:tip`). */
export interface TipEvent {
  paymentId: string;
  tripId: string;
  driverId?: string;
  tipCents: number;
}

/** Sobre de `payment:tip`: el payload viene anidado bajo `.payload` igual que `dispatch:offer`. */
interface TipEnvelope {
  eventType?: string;
  occurredAt?: string;
  payload?: TipEvent;
}

/**
 * Parada propuesta por el pasajero que el conductor recibe en vivo (Lote C4, evento `waypoint:proposed`).
 * A diferencia de dispatch:offer/payment:tip, viaja como shape PLANA (no anidada en `.payload`).
 */
export interface WaypointProposedEvent {
  proposalId: string;
  tripId: string;
  point: { lat: number; lon: number };
  deltaFareCents: number;
  newFareCents: number;
  expiresAt: string;
}

export class DriverSocket {
  private socket?: Socket;
  private readonly offers: DispatchOfferEvent[] = [];
  private offerWaiter?: (o: DispatchOfferEvent) => void;
  private readonly tips: TipEvent[] = [];
  private tipWaiter?: (t: TipEvent) => void;
  private readonly waypointProposals: WaypointProposedEvent[] = [];
  private waypointWaiter?: (w: WaypointProposedEvent) => void;

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
      socket.on('payment:tip', (envelope: TipEnvelope) => {
        const tip = envelope.payload;
        if (!tip) return;
        this.tips.push(tip);
        if (this.tipWaiter) {
          this.tipWaiter(tip);
          this.tipWaiter = undefined;
        }
      });
      // Lote C4 · parada propuesta (shape PLANA, sin sobre): la app la pinta para aceptar/rechazar.
      socket.on('waypoint:proposed', (msg: WaypointProposedEvent) => {
        if (!msg?.proposalId) return;
        this.waypointProposals.push(msg);
        if (this.waypointWaiter) {
          this.waypointWaiter(msg);
          this.waypointWaiter = undefined;
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

  /** Espera la propina en vivo `payment:tip` (ya recibida o futura). */
  waitForTip(timeoutMs: number): Promise<TipEvent> {
    const existing = this.tips[0];
    if (existing) return Promise.resolve(existing);
    return new Promise<TipEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tipWaiter = undefined;
        reject(new Error(`timeout esperando payment:tip (${timeoutMs}ms)`));
      }, timeoutMs);
      this.tipWaiter = (tp): void => {
        clearTimeout(timer);
        resolve(tp);
      };
    });
  }

  /** Espera la parada propuesta `waypoint:proposed` (ya recibida o futura). */
  waitForWaypointProposed(timeoutMs: number): Promise<WaypointProposedEvent> {
    const existing = this.waypointProposals[0];
    if (existing) return Promise.resolve(existing);
    return new Promise<WaypointProposedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waypointWaiter = undefined;
        reject(new Error(`timeout esperando waypoint:proposed (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waypointWaiter = (w): void => {
        clearTimeout(timer);
        resolve(w);
      };
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}
