'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  OPS_NAMESPACE,
  type DriverLocationMsg,
  type OpsClientToServer,
  type OpsServerToClient,
  type PanicAlertMsg,
  type TripUpdateMsg,
} from '@veo/api-client';
import { BFF_WS_URL } from '../config';

export type OpsSocket = Socket<OpsServerToClient, OpsClientToServer>;
export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface OpsHandlers {
  onDriverLocation?: (msg: DriverLocationMsg) => void;
  onTripUpdate?: (msg: TripUpdateMsg) => void;
  onPanicAlert?: (msg: PanicAlertMsg) => void;
  onPanicUpdate?: (msg: { panicId: string; status: string; at: string }) => void;
}

interface WsTicketResponse {
  ticket?: string;
}

/** Shape del payload de auth que el gateway `/ops` espera en el handshake (auth.ticket). */
interface OpsAuthPayload {
  ticket?: string;
}

/** Firma del callback `auth` dinámico de socket.io-client (se invoca en CADA (re)conexión). */
type AuthCallback = (payload: OpsAuthPayload) => void;
type AuthProvider = (cb: AuthCallback) => void;

/**
 * Pide al servidor un ticket efímero de websocket (el JWT permanece en cookie httpOnly).
 * NUNCA lanza: ante red caída o respuesta inválida devuelve `null`, de modo que el handshake
 * salga sin ticket (el gateway lo rechazará) y socket.io reintente con backoff — en vez de
 * propagar un unhandled rejection que dejaría la conexión colgada en 'connecting' para siempre.
 */
async function fetchWsTicket(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/ws-ticket', { credentials: 'include', signal });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as WsTicketResponse | null;
    return data?.ticket ?? null;
  } catch {
    // Red caída / fetch abortado: no reventamos. socket.io reintenta con su propio backoff.
    return null;
  }
}

/**
 * Construye el provider `auth` dinámico de socket.io. CAUSA RAÍZ del bug de realtime muerto:
 * el ticket es de un solo uso (Redis GETDEL, TTL 30s), así que un `auth` estático solo sirve
 * para el PRIMER handshake; tras un blip de red, socket.io reintentaba con el ticket ya consumido
 * → el gateway lo rechazaba → 'io server disconnect' → fin del realtime en silencio.
 *
 * Con `auth` como función, socket.io la invoca en cada intento de (re)conexión, re-minteando un
 * ticket FRESCO. Si el fetch falla, emitimos `{}` (sin ticket): el gateway rechaza, pero socket.io
 * sigue reintentando con backoff hasta que la red vuelva y el ticket se acuñe.
 *
 * Se exporta para poder testear la lógica sin un socket real.
 */
export function createTicketAuth(
  fetchTicket: (signal?: AbortSignal) => Promise<string | null>,
  signal?: AbortSignal,
): AuthProvider {
  return (cb) => {
    void (async () => {
      // Defensa en profundidad: aunque `fetchTicket` debería envolver sus errores, blindamos el
      // provider para que NUNCA propague un rejection. Si algo falla, emitimos `{}` (sin ticket):
      // el gateway rechaza el handshake pero socket.io reintenta con backoff — jamás queda colgado.
      let ticket: string | null = null;
      try {
        ticket = await fetchTicket(signal);
      } catch {
        ticket = null;
      }
      if (signal?.aborted) return;
      cb(ticket ? { ticket } : {});
    })();
  };
}

/** Razón de socket.io cuando el SERVIDOR cierra el socket (detiene el auto-reconnect nativo). */
const SERVER_DISCONNECT = 'io server disconnect';

/**
 * Conexión Socket.IO al namespace /ops del admin-bff. Maneja ticket, reconexión y limpieza.
 * Los handlers se leen vía ref para no recrear la conexión en cada render.
 */
export function useOpsSocket(handlers: OpsHandlers, enabled = true) {
  const [status, setStatus] = useState<SocketStatus>('idle');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    setStatus('connecting');

    const base = BFF_WS_URL || (typeof window !== 'undefined' ? window.location.origin : '');
    const socket: OpsSocket = io(`${base}${OPS_NAMESPACE}`, {
      withCredentials: true,
      transports: ['websocket'],
      // auth dinámico: re-mintea un ticket fresco (single-use) en CADA intento de (re)conexión.
      auth: createTicketAuth(fetchWsTicket, ac.signal),
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });

    socket.on('connect', () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setStatus('connected');
    });

    socket.on('disconnect', (reason) => {
      // 'io server disconnect' = el gateway nos cerró (ticket inválido tras un blip). socket.io
      // NO reintenta solo en este caso. Como el ticket ahora se re-mintea en `auth`, disparamos
      // una reconexión manual con un backoff corto: el próximo handshake usará un ticket fresco.
      // No debilita el handshake — un ticket inválido SIGUE siendo rechazado server-side; solo
      // damos al cliente la oportunidad de reintentar con uno nuevo en vez de morir en silencio.
      if (reason === SERVER_DISCONNECT && !disposed) {
        setStatus('reconnecting');
        reconnectTimer ??= setTimeout(() => {
          reconnectTimer = null;
          if (!disposed) socket.connect();
        }, 1000);
        return;
      }
      setStatus('disconnected');
    });
    socket.io.on('reconnect_attempt', () => {
      setStatus('reconnecting');
    });
    socket.io.on('error', () => {
      setStatus('reconnecting');
    });

    socket.on('driver:location', (msg) => handlersRef.current.onDriverLocation?.(msg));
    socket.on('trip:update', (msg) => handlersRef.current.onTripUpdate?.(msg));
    socket.on('panic:alert', (msg) => handlersRef.current.onPanicAlert?.(msg));
    socket.on('panic:update', (msg) => handlersRef.current.onPanicUpdate?.(msg));

    return () => {
      disposed = true;
      ac.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled]);

  return { status };
}
