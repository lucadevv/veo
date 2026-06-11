/**
 * Cliente Socket.IO del pasajero (namespace /passenger del public-bff). Hace lo que hace la app del
 * pasajero: handshake con Bearer + tripId, y escucha los eventos del viaje. Acá lo usamos para
 * observar el desenlace de una parada propuesta (`waypoint:outcome`, Lote C4) de forma determinista.
 */
import { io, type Socket } from 'socket.io-client';
import { BASE_URLS } from './config.js';

/** Desenlace de una parada (Lote C4): el conductor aceptó/rechazó o venció. Shape plana. */
export interface WaypointOutcomeEvent {
  proposalId: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
}

export class PassengerSocket {
  private socket?: Socket;
  private readonly outcomes: WaypointOutcomeEvent[] = [];
  private outcomeWaiter?: (o: WaypointOutcomeEvent) => void;

  constructor(
    private readonly token: string,
    private readonly tripId: string,
  ) {}

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = io(`${BASE_URLS.publicBff}/passenger`, {
        transports: ['websocket'],
        auth: { token: this.token, tripId: this.tripId },
        reconnection: false,
        timeout: timeoutMs,
      });
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('timeout conectando /passenger socket')), timeoutMs);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`connect_error /passenger: ${err.message}`));
      });
      socket.on('waypoint:outcome', (msg: WaypointOutcomeEvent) => {
        if (!msg?.proposalId) return;
        this.outcomes.push(msg);
        if (this.outcomeWaiter) {
          this.outcomeWaiter(msg);
          this.outcomeWaiter = undefined;
        }
      });
    });
  }

  /** Espera el desenlace `waypoint:outcome` (ya recibido o futuro). */
  waitForOutcome(timeoutMs: number): Promise<WaypointOutcomeEvent> {
    const existing = this.outcomes[0];
    if (existing) return Promise.resolve(existing);
    return new Promise<WaypointOutcomeEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outcomeWaiter = undefined;
        reject(new Error(`timeout esperando waypoint:outcome (${timeoutMs}ms)`));
      }, timeoutMs);
      this.outcomeWaiter = (o): void => {
        clearTimeout(timer);
        resolve(o);
      };
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}
