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

/** Pide al servidor un ticket efímero de websocket (el JWT permanece en cookie httpOnly). */
async function fetchWsTicket(signal: AbortSignal): Promise<string | null> {
  const res = await fetch('/api/auth/ws-ticket', { credentials: 'include', signal });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as WsTicketResponse | null;
  return data?.ticket ?? null;
}

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
    let socket: OpsSocket | null = null;
    let disposed = false;

    setStatus('connecting');
    void (async () => {
      const ticket = await fetchWsTicket(ac.signal);
      if (disposed || ac.signal.aborted) return;

      const base = BFF_WS_URL || (typeof window !== 'undefined' ? window.location.origin : '');
      socket = io(`${base}${OPS_NAMESPACE}`, {
        withCredentials: true,
        transports: ['websocket'],
        auth: ticket ? { ticket } : {},
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
      });

      socket.on('connect', () => {
        setStatus('connected');
      });
      socket.on('disconnect', () => {
        setStatus('disconnected');
      });
      socket.io.on('reconnect_attempt', () => {
        setStatus('reconnecting');
      });
      socket.io.on('error', () => {
        setStatus('disconnected');
      });

      socket.on('driver:location', (msg) => handlersRef.current.onDriverLocation?.(msg));
      socket.on('trip:update', (msg) => handlersRef.current.onTripUpdate?.(msg));
      socket.on('panic:alert', (msg) => handlersRef.current.onPanicAlert?.(msg));
      socket.on('panic:update', (msg) => handlersRef.current.onPanicUpdate?.(msg));
    })();

    return () => {
      disposed = true;
      ac.abort();
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
      }
    };
  }, [enabled]);

  return { status };
}
