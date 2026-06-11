import {useEffect, useRef, useState} from 'react';
import type {
  ChatMessage,
  DispatchMatchPayload,
  DispatchOfferedPayload,
  DriverEventEnvelope,
  TipAddedPayload,
  WaypointProposedMsg,
} from '@veo/api-client';
import {useDi} from '../../../../core/di/useDi';
import type {DriverSocket} from '../../../../core/realtime/socket';

export interface DriverRealtimeHandlers {
  /**
   * Oferta directa entrante: el conductor debe aceptar/rechazar antes de `expiresAt`.
   *
   * `scheduled` indica una RESERVA (viaje programado). NO está en el contrato `@veo/api-client`
   * todavía: el dispatch puede marcarlo en el payload o en el sobre del evento, así que se lee de
   * forma defensiva. Si no viene la marca, queda `false` (degrada sin badge).
   */
  onOffer(payload: DispatchOfferedPayload, scheduled: boolean): void;
  /** Match confirmado: hay un viaje activo asignado. */
  onMatch(payload: DispatchMatchPayload): void;
  /** Cambio de estado del viaje reenviado desde Kafka. */
  onTripUpdate(envelope: DriverEventEnvelope<unknown>): void;
  /**
   * Mensaje de chat entrante del pasajero. A diferencia de los eventos de dominio, el driver-bff
   * emite el `ChatMessage` "pelado" (NO envuelto en `DriverEventEnvelope`).
   */
  onChatMessage(message: ChatMessage): void;
  /** Propina recibida en vivo (el 100% es del conductor). El payload viene en el sobre de dominio. */
  onTipAdded(payload: TipAddedPayload): void;
  /**
   * El pasajero PROPUSO una parada mid-trip (Lote C4). El driver-bff emite la shape TIPADA plana (NO
   * envuelta en `DriverEventEnvelope`): el conductor la acepta/rechaza antes de `expiresAt`.
   */
  onWaypointProposed(message: WaypointProposedMsg): void;
}

/**
 * Gestiona el ciclo de vida del socket `/driver` y enruta sus eventos a los handlers.
 *
 * - Conecta cuando `enabled` (turno/sesión activa) y desconecta al salir.
 * - Re-lee el access token en cada (re)conexión (lo hace `createDriverSocket`).
 * - Los handlers se guardan en un ref para no re-suscribir listeners en cada render.
 *
 * Devuelve el socket vivo para que el publisher de GPS pueda emitir `location`.
 */
/**
 * Lee la marca de "viaje programado" (reserva) del evento `dispatch:offer`.
 *
 * El contrato `@veo/api-client` aún no tipa `scheduled`, pero el dispatch puede incluirlo en el
 * payload o en el sobre. Se inspecciona ambos sin castear a `any` (acceso vía `Record<string, unknown>`)
 * y se considera reserva solo cuando el flag es estrictamente `true`. Cualquier otra forma degrada a
 * `false` (no se muestra el badge).
 */
function readScheduledFlag(msg: DriverEventEnvelope<DispatchOfferedPayload>): boolean {
  // Defensa: el sobre o el payload pueden llegar "pelados" (sin `payload`) si el dispatch emite un
  // evento fuera de contrato. Se accede a ambos como `Record` opcional para no reventar el handler.
  const envelope = (msg ?? {}) as unknown as Record<string, unknown>;
  const payload = (msg?.payload ?? {}) as unknown as Record<string, unknown>;
  return payload.scheduled === true || envelope.scheduled === true;
}

export function useDriverRealtime(enabled: boolean, handlers: DriverRealtimeHandlers): DriverSocket | null {
  const di = useDi();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [socket, setSocket] = useState<DriverSocket | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const s = di.createDriverSocket();

    // Toda excepción lanzada dentro de un callback de socket.io es NO capturada y, en build Release
    // (sin LogBox), tumba la app. Por eso cada listener envuelve su handler: un evento malformado o
    // "pelado" (sin `payload`, o de una forma inesperada) se ignora en silencio en vez de crashear.
    const safe = <T>(fn: (msg: T) => void) => (msg: T) => {
      try {
        fn(msg);
      } catch {
        // Evento fuera de contrato: degradar sin delatar nada (regla #2) y sin tumbar la app.
      }
    };

    const onOffer = safe((msg: DriverEventEnvelope<DispatchOfferedPayload>) => {
      if (!msg?.payload?.matchId || !msg.payload.tripId) {
        return;
      }
      handlersRef.current.onOffer(msg.payload, readScheduledFlag(msg));
    });
    const onMatch = safe((msg: DriverEventEnvelope<DispatchMatchPayload>) => {
      if (!msg?.payload?.tripId) {
        return;
      }
      handlersRef.current.onMatch(msg.payload);
    });
    const onTripUpdate = safe((msg: DriverEventEnvelope<unknown>) =>
      handlersRef.current.onTripUpdate(msg),
    );
    const onChatMessage = safe((msg: ChatMessage) => {
      if (!msg?.id) {
        return;
      }
      handlersRef.current.onChatMessage(msg);
    });
    const onTipAdded = safe((msg: DriverEventEnvelope<TipAddedPayload>) => {
      // Defensa: solo celebramos propinas con monto válido (entero positivo) y viaje conocido.
      if (!msg?.payload?.tripId || !(msg.payload.tipCents > 0)) {
        return;
      }
      handlersRef.current.onTipAdded(msg.payload);
    });
    const onWaypointProposed = safe((msg: WaypointProposedMsg) => {
      // Defensa: ignoramos propuestas malformadas (sin id/viaje); el server garantiza el resto.
      if (!msg?.proposalId || !msg.tripId) {
        return;
      }
      handlersRef.current.onWaypointProposed(msg);
    });

    s.on('dispatch:offer', onOffer);
    s.on('dispatch:match', onMatch);
    s.on('trip:update', onTripUpdate);
    s.on('chat:message', onChatMessage);
    s.on('payment:tip', onTipAdded);
    s.on('waypoint:proposed', onWaypointProposed);
    s.connect();
    setSocket(s);

    return () => {
      s.off('dispatch:offer', onOffer);
      s.off('dispatch:match', onMatch);
      s.off('trip:update', onTripUpdate);
      s.off('chat:message', onChatMessage);
      s.off('payment:tip', onTipAdded);
      s.off('waypoint:proposed', onWaypointProposed);
      s.disconnect();
      setSocket(null);
    };
  }, [enabled, di]);

  return socket;
}
