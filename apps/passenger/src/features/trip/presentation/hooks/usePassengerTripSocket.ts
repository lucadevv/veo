import type {
  ChatMessage,
  GeoPoint,
  OfferMadeMsg,
  TripStatus,
  WaypointProposalOutcome,
} from '@veo/api-client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {createPassengerSocket} from '../../../../core/realtime/socket';
import {useSessionStore} from '../../../../core/session/sessionStore';

/** Snapshot en vivo del viaje recibido por el socket `/passenger`. */
export interface LiveTripState {
  status: TripStatus | null;
  driverLocation: GeoPoint | null;
  /**
   * Rumbo del conductor en grados (0=N, 90=E), del último `driver:location`. `null` si el backend no
   * lo manda. Se usa para rotar el ícono del taxi en el mapa; si es `null` NO se rota (mejor sin
   * rotación que un salto brusco a 0°).
   */
  driverHeading: number | null;
  etaSeconds: number | null;
  ended: boolean;
  connected: boolean;
  /** Mensajes de chat entrantes (evento `chat:message`) recibidos durante esta sesión de socket. */
  incomingMessages: ChatMessage[];
  /** PUJA · ofertas entrantes en vivo (evento `offer:made`); una por conductor (la última gana). */
  incomingOffers: OfferMadeMsg[];
  /** BE-3 · driverIds cuyas ofertas se RETIRARON (evento `offer:withdrawn`); el board las excluye al instante. */
  withdrawnDriverIds: string[];
  /**
   * Lote C4 · último DESENLACE de una parada propuesta (evento `waypoint:outcome`): el conductor
   * aceptó/rechazó o venció. La pantalla lo pasa a `useWaypointProposal` para cerrar el "esperando".
   * `null` mientras no llegó ninguno en esta sesión de socket.
   */
  waypointOutcome: WaypointProposalOutcome | null;
}

const INITIAL: LiveTripState = {
  status: null,
  driverLocation: null,
  driverHeading: null,
  etaSeconds: null,
  ended: false,
  connected: false,
  incomingMessages: [],
  incomingOffers: [],
  withdrawnDriverIds: [],
  waypointOutcome: null,
};

/**
 * Conecta al namespace `/passenger` durante la vida de la pantalla de viaje activo y agrega los
 * eventos (`trip:update`, `driver:location`, `eta`, `trip:ended`) en un estado en vivo. El handshake
 * lleva el Bearer y el `tripId`; el gateway valida que el viaje sea de ESTE pasajero y esté activo.
 *
 * El polling REST de respaldo (`GET /trips/:id/state`) lo hace la pantalla vía React Query; este
 * hook es la fuente primaria de baja latencia.
 *
 * El mismo socket transporta el chat del viaje (evento `chat:message`): los mensajes entrantes se
 * acumulan en `incomingMessages` para que la pantalla de chat los agregue a su estado, y
 * `acknowledgeMessages()` los drena una vez consumidos (evita re-procesarlos y permite el badge).
 */
export interface UsePassengerTripSocket extends LiveTripState {
  /** Marca como consumidos los mensajes entrantes ya integrados por la pantalla de chat. */
  acknowledgeMessages: (ids: string[]) => void;
}

export function usePassengerTripSocket(
  tripId: string,
  /**
   * ¿Debe el socket conectar? El namespace `/passenger` SOLO tiene algo que entregar (driver:location,
   * eta, trip:update, chat, ofertas) mientras el viaje está VIVO (enRoute/arriving/arrived/inProgress) o
   * en la PUJA. En `completed`/settlement (re-entrada al cierre) NO hay nada que escuchar por este canal
   * —el recibo se actualiza por poll REST— y el gateway del BFF RECHAZA el handshake ("el viaje no está
   * activo"), reintentando en loop. Gateamos acá: si el viaje no está vivo, NO intentamos conectar.
   * Default `true` para no alterar a los llamadores que ya viven solo en fases vivas (chat, board, activo).
   */
  enabled = true,
): UsePassengerTripSocket {
  const accessToken = useSessionStore(state => state.accessToken);
  const [state, setState] = useState<LiveTripState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  const acknowledgeMessages = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    const consumed = new Set(ids);
    setState(prev => ({
      ...prev,
      incomingMessages: prev.incomingMessages.filter(
        msg => !consumed.has(msg.id),
      ),
    }));
  }, []);

  useEffect(() => {
    // Sin token, sin viaje (idle/cotización) o con el viaje NO vivo (completed/settlement) NO conectamos:
    // el socket de tracking solo vive cuando hay un viaje real y activo al que suscribirse. Esto evita la
    // conexión ociosa en el Home Y el loop de handshakes rechazados por el gateway en la re-entrada al
    // cierre (trip COMPLETED). Al desconectar, reseteamos a INITIAL para no arrastrar un `status` viejo.
    if (!accessToken || !tripId || !enabled) {
      setState(prev => (prev === INITIAL ? prev : INITIAL));
      return;
    }

    // El token se relee del store en cada (re)conexión (no se captura estático): si el JWT expira
    // mid-viaje, la reconexión usa el token refrescado y el tracking en vivo no se congela.
    const socket = createPassengerSocket({
      getToken: () => useSessionStore.getState().accessToken,
      tripId,
    });

    socket.on('connect', () => setState(prev => ({...prev, connected: true})));
    socket.on('disconnect', () =>
      setState(prev => ({...prev, connected: false})),
    );

    socket.on('trip:update', msg => {
      setState(prev => ({
        ...prev,
        status: msg.status,
        etaSeconds: msg.etaSeconds ?? prev.etaSeconds,
        driverLocation: msg.driverLocation ?? prev.driverLocation,
      }));
    });

    socket.on('driver:location', msg => {
      setState(prev => ({
        ...prev,
        driverLocation: msg.point,
        driverHeading: msg.heading,
      }));
    });

    socket.on('eta', msg => {
      setState(prev => ({...prev, etaSeconds: msg.etaSeconds}));
    });

    socket.on('trip:ended', msg => {
      setState(prev => ({...prev, status: msg.status, ended: true}));
    });

    // Mensaje de chat entrante del conductor: se acumula sin duplicar (idempotente por id), para que
    // la pantalla de chat lo agregue a su estado y luego lo drene con `acknowledgeMessages`.
    socket.on('chat:message', msg => {
      setState(prev =>
        prev.incomingMessages.some(existing => existing.id === msg.id)
          ? prev
          : {...prev, incomingMessages: [...prev.incomingMessages, msg]},
      );
    });

    // PUJA · oferta entrante: se acumula por conductor (la última oferta de ese driver pisa la anterior,
    // p. ej. si pasa de COUNTER a otro precio). La pantalla del board las fusiona con el snapshot REST.
    socket.on('offer:made', msg => {
      setState(prev => ({
        ...prev,
        incomingOffers: [
          ...prev.incomingOffers.filter(o => o.driverId !== msg.driverId),
          msg,
        ],
        // Una nueva oferta DES-RETIRA al conductor: si había sido retirado y vuelve a ofertar (oferta
        // fresca válida), ya no debe quedar excluido del board (si no, su re-oferta sería invisible).
        withdrawnDriverIds: prev.withdrawnDriverIds.filter(
          id => id !== msg.driverId,
        ),
      }));
    });

    // BE-3 · una oferta se retiró (conductor no elegible): la quitamos de las entrantes y marcamos su
    // driverId como retirado para que el board la excluya también del snapshot REST (al instante).
    socket.on('offer:withdrawn', msg => {
      setState(prev => ({
        ...prev,
        incomingOffers: prev.incomingOffers.filter(
          o => o.driverId !== msg.driverId,
        ),
        withdrawnDriverIds: prev.withdrawnDriverIds.includes(msg.driverId)
          ? prev.withdrawnDriverIds
          : [...prev.withdrawnDriverIds, msg.driverId],
      }));
    });

    // Lote C4 · desenlace de una parada propuesta: el conductor aceptó/rechazó o venció. Se guarda el
    // último; `useWaypointProposal` lo consume (idempotente por proposalId) para cerrar el "esperando".
    socket.on('waypoint:outcome', msg => {
      setState(prev => ({...prev, waypointOutcome: msg}));
    });

    socket.connect();
    // Pide al servidor reemitir el último snapshot conocido al (re)conectar.
    socket.on('connect', () => socket.emit('resync'));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [accessToken, tripId, enabled]);

  return {...state, acknowledgeMessages};
}
