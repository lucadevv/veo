import { useEffect, useRef, useState } from 'react';
import {
  HANDSHAKE_SESSION_REVOKED,
  type ChatMessage,
  type DispatchMatchPayload,
  type DispatchOfferWithdrawnPayload,
  type DispatchOfferedPayload,
  type DriverEventEnvelope,
  type TipAddedPayload,
  type WaypointProposedMsg,
} from '@veo/api-client';
import { useDi } from '../../../../core/di/useDi';
import type { DriverSocket } from '../../../../core/realtime/socket';
import { useDispatchStore } from '../state/dispatchStore';

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
  /**
   * ADR-020 Lote 2 (2a) · una puja del conductor se CERRÓ (el pasajero eligió a otro / quedó inelegible):
   * la app remueve la card de esa puja al instante y limpia el estado "esperando al pasajero" (2b), sin
   * depender del poll de 12s ni dejar que el conductor tapee una card muerta (409).
   */
  onBidClosed(payload: DispatchOfferWithdrawnPayload): void;
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
  /**
   * Cambió el estado de la conexión del socket `/driver`: `true` al (re)conectar, `false` al caerse.
   * La presentación lo refleja en un indicador (p. ej. "Reconectando…") para no fingir tiempo real
   * cuando el conductor está aislado (túnel, zona muerta).
   */
  onConnectionChange(connected: boolean): void;
  /**
   * RE-SINCRONIZACIÓN tras RECONECTAR (NO en la conexión inicial). Mientras el socket estuvo caído
   * (túnel, zona muerta) un `dispatch:match`/`trip:update` pudo perderse: el namespace `/driver` NO
   * reemite el último snapshot (a diferencia de `/passenger`, que tiene un `resync` server-side en el
   * contrato y el gateway). Como acá NO existe ese evento ni en `DriverClientToServer` ni en el
   * `DriverGateway`, la recuperación es por REST: la presentación invalida las queries del viaje
   * activo / pujas para refetchear el estado AUTORITATIVO del servidor. NO se dispara en la primera
   * conexión porque al montar las queries ya cargan fresco (evita el doble fetch del caso feliz).
   */
  onResync(): void;
  /**
   * SINGLE ACTIVE SESSION: el conductor inició sesión en OTRO dispositivo (login más nuevo) → esta sesión
   * quedó superada. La presentación cierra la sesión local y vuelve al login. No se reconecta: el server ya
   * rechaza esta sesión (su `sid` es más viejo), así que no hay guerra de reconexión.
   */
  onSessionSuperseded(): void;
  /**
   * ENFORCEMENT DE REVOCACIÓN: el servidor RECHAZÓ el handshake porque la sesión está revocada (logout
   * remoto, suspensión, o superada por un login nuevo) → el access token, aunque su firma siga válida,
   * ya no sirve. La presentación cierra la sesión local y vuelve al login. Se dispara SOLO ante el
   * `connect_error` con el motivo explícito del server; un error de transporte transitorio NO lo dispara.
   */
  onSessionRevoked(): void;
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

export function useDriverRealtime(
  enabled: boolean,
  handlers: DriverRealtimeHandlers,
): DriverSocket | null {
  const di = useDi();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [socket, setSocket] = useState<DriverSocket | null>(null);
  // RECONEXIÓN MANUAL ("Reintentar" del overlay de sin-conexión): al bumpear el nonce, el efecto se
  // re-ejecuta → derriba el socket viejo y crea uno FRESCO que conecta ya (token re-leído), sin esperar
  // el backoff de socket.io. Es lo que le da dientes al botón (antes solo refetcheaba queries).
  const reconnectNonce = useDispatchStore((s) => s.reconnectNonce);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const s = di.createDriverSocket();

    // Toda excepción lanzada dentro de un callback de socket.io es NO capturada y, en build Release
    // (sin LogBox), tumba la app. Por eso cada listener envuelve su handler: un evento malformado o
    // "pelado" (sin `payload`, o de una forma inesperada) se ignora en silencio en vez de crashear.
    const safe =
      <T>(fn: (msg: T) => void) =>
      (msg: T) => {
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
    const onBidClosed = safe((msg: DriverEventEnvelope<DispatchOfferWithdrawnPayload>) => {
      if (!msg?.payload?.tripId) {
        return;
      }
      handlersRef.current.onBidClosed(msg.payload);
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

    // socket.io re-emite `connect` en CADA (re)conexión. Distinguimos la PRIMERA (al montar, las
    // queries ya cargan fresco solas) de las posteriores (RECONEXIÓN tras un corte: ahí SÍ hay que
    // recuperar lo perdido por REST). El flag es local al ciclo de vida del socket (se reinicia con él).
    let hasConnectedOnce = false;
    // `connect`/`disconnect` no llevan payload de dominio: se envuelven en su propio try/catch (en vez
    // de `safe`, que exige un parámetro) para no tumbar la app si un handler de la presentación lanza.
    const onConnect = () => {
      try {
        handlersRef.current.onConnectionChange(true);
        if (hasConnectedOnce) {
          // RECONEXIÓN: un `dispatch:match`/`trip:update` pudo perderse durante el corte → recuperar.
          handlersRef.current.onResync();
        }
        hasConnectedOnce = true;
      } catch {
        // Degradar sin tumbar la app (mismo criterio que los listeners de dominio).
      }
    };
    const onDisconnect = () => {
      try {
        handlersRef.current.onConnectionChange(false);
      } catch {
        // Degradar sin tumbar la app.
      }
    };
    // SINGLE ACTIVE SESSION: el server avisa que esta sesión quedó superada por un login más nuevo en otro
    // device → la presentación cierra la sesión local. Sin payload; se envuelve en try/catch como los demás.
    const onSessionSuperseded = () => {
      try {
        handlersRef.current.onSessionSuperseded();
      } catch {
        // Degradar sin tumbar la app.
      }
    };
    // ENFORCEMENT DE REVOCACIÓN: `connect_error` se dispara TANTO por rechazos del server (middleware del
    // handshake) COMO por fallos de transporte (server caído, red, timeout). Distinguimos por el MOTIVO
    // explícito: solo el `HANDSHAKE_SESSION_REVOKED` que pone el gateway significa "sesión muerta, deslogueá".
    // Cualquier otro `connect_error` es transitorio → NO desloguea (socket.io reintenta reconectar solo).
    const onConnectError = (err: Error) => {
      try {
        if (err?.message === HANDSHAKE_SESSION_REVOKED) {
          handlersRef.current.onSessionRevoked();
        }
      } catch {
        // Degradar sin tumbar la app.
      }
    };

    s.on('dispatch:offer', onOffer);
    s.on('dispatch:match', onMatch);
    s.on('bid:closed', onBidClosed);
    s.on('trip:update', onTripUpdate);
    s.on('chat:message', onChatMessage);
    s.on('payment:tip', onTipAdded);
    s.on('waypoint:proposed', onWaypointProposed);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.on('session:superseded', onSessionSuperseded);
    s.connect();
    setSocket(s);

    return () => {
      s.off('dispatch:offer', onOffer);
      s.off('dispatch:match', onMatch);
      s.off('bid:closed', onBidClosed);
      s.off('trip:update', onTripUpdate);
      s.off('chat:message', onChatMessage);
      s.off('payment:tip', onTipAdded);
      s.off('waypoint:proposed', onWaypointProposed);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onConnectError);
      s.off('session:superseded', onSessionSuperseded);
      s.disconnect();
      setSocket(null);
      // Al desmontar/deshabilitar, el indicador ya no debe quedar "conectado" de un socket muerto.
      handlersRef.current.onConnectionChange(false);
    };
    // `reconnectNonce` en las deps: un tap en "Reintentar" lo bumpea → cleanup (derriba el socket) + re-run
    // (socket fresco que reconecta). El resto de deps no cambia en caliente.
  }, [enabled, di, reconnectNonce]);

  return socket;
}
