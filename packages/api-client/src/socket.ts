/**
 * Contrato Socket.IO compartido (BFF gateway ↔ web). Tipado fuerte de eventos por namespace.
 * - /family (public-bff): seguimiento en vivo desde link firmado. Auth = token de share en handshake.
 * - /ops (admin-bff): monitor de operación/seguridad. Auth = ticket efímero de un solo uso
 *   (auth.ticket en el handshake), acuñado server-side desde la cookie httpOnly de admin-web.
 *   El JWT admin nunca llega al navegador.
 * Usar con socket.io-client: io(url, { auth }) tipado vía estos mapas.
 */
import type { GeoPoint, TripStatus } from './types.js';

export interface DriverLocationMsg {
  tripId: string;
  driverId: string;
  point: GeoPoint;
  heading: number | null;
  speedKph: number | null;
  at: string;
}

export interface TripUpdateMsg {
  tripId: string;
  status: TripStatus;
  etaSeconds: number | null;
  driverLocation: GeoPoint | null;
  at: string;
}

export interface PanicAlertMsg {
  panicId: string;
  tripId: string;
  passengerId: string;
  geo: GeoPoint;
  status: string;
  triggeredAt: string;
}

/* ── Namespace /family ── */
export interface FamilyServerToClient {
  'trip:update': (msg: TripUpdateMsg) => void;
  'driver:location': (msg: DriverLocationMsg) => void;
  'trip:ended': (msg: { tripId: string; status: TripStatus; at: string }) => void;
  'link:revoked': (msg: { tripId: string }) => void;
  error: (msg: { code: string; message: string }) => void;
}
export interface FamilyClientToServer {
  /** El cliente se une a la sala del viaje; el token va en el handshake (auth.token). */
  subscribe: (msg: { token: string }) => void;
}
export interface FamilyHandshakeAuth {
  token: string;
}

/* ── Namespace /ops ── */
export interface OpsServerToClient {
  'driver:location': (msg: DriverLocationMsg) => void;
  'trip:update': (msg: TripUpdateMsg) => void;
  'panic:alert': (msg: PanicAlertMsg) => void;
  'panic:update': (msg: { panicId: string; status: string; at: string }) => void;
}
export interface OpsClientToServer {
  /** Suscribirse a una zona/bbox para no recibir todo el tráfico. */
  watch: (msg: { bbox?: [number, number, number, number]; tripId?: string }) => void;
}
/** Handshake del namespace /ops: ticket efímero de un solo uso (no el JWT admin). */
export interface OpsHandshakeAuth {
  ticket: string;
}

export const FAMILY_NAMESPACE = '/family';
export const OPS_NAMESPACE = '/ops';
