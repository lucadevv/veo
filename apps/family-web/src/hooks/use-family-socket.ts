'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  FAMILY_NAMESPACE,
  type DriverLocationMsg,
  type FamilyClientToServer,
  type FamilyServerToClient,
  type TripStatus,
  type TripUpdateMsg,
} from '@veo/api-client';
import { publicEnv } from '@/lib/env';

export interface FamilySocketHandlers {
  onTripUpdate: (msg: TripUpdateMsg) => void;
  onDriverLocation: (msg: DriverLocationMsg) => void;
  onTripEnded: (msg: { tripId: string; status: TripStatus; at: string }) => void;
  onRevoked: (msg: { tripId: string }) => void;
}

type FamilySocket = Socket<FamilyServerToClient, FamilyClientToServer>;

/**
 * Suscribe al namespace /family del public-bff con el token del link en el handshake.
 * Reconexión automática y limpieza completa al desmontar. Devuelve el estado de conexión
 * para alimentar el indicador "EN VIVO".
 */
export function useFamilySocket(token: string, handlers: FamilySocketHandlers): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  // Ref para usar siempre los últimos handlers sin re-suscribir el socket.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const url = `${publicEnv.bffWsUrl.replace(/\/$/, '')}${FAMILY_NAMESPACE}`;
    const socket: FamilySocket = io(url, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      timeout: 10_000,
    });

    socket.on('connect', () => {
      setConnected(true);
      // El token también va en el handshake; reafirmamos la suscripción a la sala del viaje.
      socket.emit('subscribe', { token });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.io.on('reconnect_attempt', () => setConnected(false));

    socket.on('trip:update', (msg) => handlersRef.current.onTripUpdate(msg));
    socket.on('driver:location', (msg) => handlersRef.current.onDriverLocation(msg));
    socket.on('trip:ended', (msg) => handlersRef.current.onTripEnded(msg));
    socket.on('link:revoked', (msg) => handlersRef.current.onRevoked(msg));
    socket.on('error', () => setConnected(false));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [token]);

  return { connected };
}
