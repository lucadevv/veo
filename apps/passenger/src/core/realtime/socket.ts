import {
  PASSENGER_NAMESPACE,
  type PassengerClientToServer,
  type PassengerServerToClient,
} from '@veo/api-client';
import { io, type Socket } from 'socket.io-client';
import { env } from '../config/env';

/**
 * Socket del pasajero, tipado con los mapas de eventos de `@veo/api-client`:
 *  - Servidor → cliente: `trip:update`, `driver:location`, `eta`, `trip:ended`, `error`.
 *  - Cliente → servidor: `resync`.
 */
export type PassengerSocket = Socket<
  PassengerServerToClient,
  PassengerClientToServer
>;

/** Opciones para crear el socket del pasajero. El token NO se captura estático: se relee por reconexión. */
export interface CreatePassengerSocketOptions {
  /**
   * Lee el access token vigente en CADA (re)conexión. Crítico: si el JWT expira durante el viaje,
   * socket.io reintenta el handshake y debe usar el token nuevo (tras refresh), no el viejo capturado
   * al conectar — de lo contrario el tracking en vivo se congela tras la expiración.
   */
  getToken: () => string | null;
  /** El viaje al que se suscribe; el gateway valida que sea de ESTE pasajero y esté activo. */
  tripId: string;
}

/**
 * Crea (sin conectar) un socket al namespace `/passenger` del public-bff.
 *
 * El gateway valida en el handshake el `auth.token` (Bearer, type=passenger) y el
 * `auth.tripId` (que el viaje sea de ESE pasajero y esté activo). El llamador decide
 * cuándo conectar (`socket.connect()`) y desconectar (`socket.disconnect()`), típicamente
 * ligado al ciclo de vida de la pantalla de viaje activo.
 *
 * `auth` como FUNCIÓN: re-lee el token en cada (re)conexión (espejo del socket del conductor),
 * para que una reconexión tras expirar el JWT use el token refrescado.
 */
export function createPassengerSocket(
  opts: CreatePassengerSocketOptions,
): PassengerSocket {
  return io(`${env.publicBffWsUrl}${PASSENGER_NAMESPACE}`, {
    // Soberanía/estabilidad móvil: WebSocket directo, sin long-polling.
    transports: ['websocket'],
    // El ciclo de conexión lo controla la feature, no el constructor.
    autoConnect: false,
    auth: (cb) => cb({ token: opts.getToken() ?? '', tripId: opts.tripId }),
  });
}
