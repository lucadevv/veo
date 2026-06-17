import { io, type Socket } from 'socket.io-client';
import { DRIVER_NAMESPACE } from '@veo/api-client';
import type { DriverClientToServer, DriverServerToClient } from '@veo/api-client';
import { env } from '../config/env';
import type { SessionTokenPort } from '../network/http';

/** Socket del namespace `/driver`, tipado con los mapas de eventos del contrato `@veo/api-client`. */
export type DriverSocket = Socket<DriverServerToClient, DriverClientToServer>;

/**
 * Crea (sin conectar) el cliente Socket.IO del conductor contra el namespace `/driver` del driver-bff.
 *
 * - `autoConnect: false`: la conexión la dispara la capa de presentación cuando el turno está activo.
 * - `auth` como función: re-lee el access token en cada (re)conexión desde el store de sesión.
 * - `transports: ['websocket']`: en móvil evitamos el long-polling inicial.
 */
export function createDriverSocket(port: SessionTokenPort): DriverSocket {
  const url = `${env.DRIVER_BFF_WS_URL}${DRIVER_NAMESPACE}`;
  return io(url, {
    transports: ['websocket'],
    autoConnect: false,
    auth: (cb) => cb({ token: port.getAccessToken() ?? '' }),
  });
}
