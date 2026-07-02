import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  navigateToBids,
  navigateToIncoming,
  navigateToTripActive,
} from '../../../navigation/navigationRef';
import { useDi } from '../../../core/di/useDi';
import { useSessionStore } from '../../../core/session/sessionStore';
import { SHIFT_STATE_QUERY_KEY } from '../../shift/presentation/hooks/useShift';
import { useShiftState } from '../../shift/presentation/hooks/useShift';
import { isOnShift } from '../../shift/domain';
import { isTripTerminal, parseTripStatus } from '../../trips/domain';
import { TRIP_QUERY_PREFIX, useActiveTrip, useTrip } from '../../trips/presentation/hooks/useTrips';
import { BIDS_QUERY_KEY } from '../../bidding/presentation';
import type { OpenBid } from '../../bidding/domain';
import { useChatStore } from '../../chat/presentation';
import {
  EARNINGS_BREAKDOWN_QUERY_KEY,
  EARNINGS_SUMMARY_QUERY_KEY,
} from '../../earnings/presentation/hooks/useEarnings';
import { useDriverRealtime } from './hooks/useDriverRealtime';
import { useLocationPublisher } from './hooks/useLocationPublisher';
import { useDispatchStore } from './state/dispatchStore';
import { useTipStore } from './state/tipStore';
import { useWaypointProposalStore } from './state/waypointProposalStore';

/**
 * Cablea el realtime del conductor mientras la sesión está activa: conecta el socket `/driver`,
 * enruta ofertas/cambios de estado y activa el publisher de GPS cuando el conductor está en turno.
 * No renderiza UI; navega mediante `navigationRef` (no requiere contexto de pantalla).
 */
export const RealtimeManager = (): null => {
  const queryClient = useQueryClient();
  const { foregroundService } = useDi();
  const setIncomingOffer = useDispatchStore((s) => s.setIncomingOffer);
  const clearOffer = useDispatchStore((s) => s.clearOffer);
  const clearPendingBid = useDispatchStore((s) => s.clearPendingBid);
  const setPujaRebidNotice = useDispatchStore((s) => s.setPujaRebidNotice);
  const setActiveTripId = useDispatchStore((s) => s.setActiveTripId);
  const setConnected = useDispatchStore((s) => s.setConnected);
  const activeTripId = useDispatchStore((s) => s.activeTripId);
  const receiveMessage = useChatStore((s) => s.receiveMessage);
  const setTip = useTipStore((s) => s.setTip);
  const setWaypointProposal = useWaypointProposalStore((s) => s.setProposal);

  const { data: shift } = useShiftState();
  const onShift = shift ? isOnShift(shift.status) : false;

  // El viaje activo deja de ser activo cuando alcanza un estado TERMINAL (completado, cancelado,
  // vencido, fallido o reasignado). `activeTripId` es estado de cliente: si no lo limpiamos, el
  // dashboard sigue mostrando "Ver viaje activo" apuntando a un viaje muerto. Lo derivamos del status
  // AUTORITATIVO del viaje (no del tipo de evento), así funciona igual por push o por refetch, y en
  // cualquier pantalla. Antes solo se limpiaba con el tap manual en TripActive (hallazgo #4).
  const activeTrip = useTrip(activeTripId ?? '');
  useEffect(() => {
    if (
      activeTripId &&
      activeTrip.data &&
      isTripTerminal(parseTripStatus(activeTrip.data.status))
    ) {
      setActiveTripId(null);
    }
  }, [activeTripId, activeTrip.data, setActiveTripId]);

  // REHIDRATACIÓN tras un reinicio (regla #4: cámara viva TODO el viaje). `activeTripId` vive en memoria
  // volátil: si el conductor mató la app mid-viaje, al reabrir perdía el viaje Y el publisher de
  // seguridad (solo corre dentro de TripActive). Lo recuperamos del SERVIDOR (fuente de verdad) UNA vez
  // por arranque; si hay un viaje vivo, lo restauramos y volvemos a su pantalla → el publisher se reanuda
  // solo (useTripPublisher). Server-derived, no estado de cliente persistido (que podría quedar stale).
  const activeTripRecovery = useActiveTrip();
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (recoveredRef.current || activeTripRecovery.isLoading) {
      return;
    }
    recoveredRef.current = true;
    const recovered = activeTripRecovery.data;
    if (recovered && !isTripTerminal(parseTripStatus(recovered.status))) {
      setActiveTripId(recovered.id);
      navigateToTripActive(recovered.id);
    }
  }, [activeTripRecovery.isLoading, activeTripRecovery.data, setActiveTripId]);

  // Foreground Service obligatorio en Android (regla #3): se enciende mientras hay turno activo y se
  // apaga al finalizar. Mantiene GPS + WebRTC vivos en background. En iOS es no-op (UIBackgroundModes).
  useEffect(() => {
    if (!onShift) {
      return;
    }
    foregroundService.start().catch(() => undefined);
    return () => {
      foregroundService.stop().catch(() => undefined);
    };
  }, [onShift, foregroundService]);

  // Compliance (regla #2: UI engañosa al pánico): el namespace `/driver` NO entrega eventos de
  // pánico por contrato (solo dispatch/trip). Un `trip:update` que llegue por una cancelación de
  // seguridad se renderiza como un estado normal (p. ej. "Cancelado"), sin delatar el pánico.
  const socket = useDriverRealtime(true, {
    onOffer: (payload, scheduled) => {
      // PUJA (marketplace "proponé tu precio"): el ping trae `bidCents` → NO es una oferta FIXED a
      // aceptar/rechazar, es una puja abierta a la que el conductor contraoferta. Refrescamos el board y,
      // si no está en un viaje, lo llevamos a las pujas. NO usamos el flujo FIXED (TripIncoming/incomingOffer).
      if (payload.bidCents != null) {
        // ADR-020 Lote 2: el MISMO viaje pudo llegar antes como oferta FIXED (TripIncoming) y ahora
        // re-abre como PUJA (schedule flip / rebid FIXED→PUJA). Sin este clearOffer quedaba un "Viaje
        // entrante" FANTASMA en el store + en el back-stack: el conductor volvía a esa pantalla, tapeaba
        // Aceptar sobre un match ya superado → 404 "la oferta venció / viaje no encontrado". Limpiamos la
        // oferta FIXED colgada al pasar el viaje a modo puja.
        // J4 · si el MISMO viaje estaba como oferta FIXED ("Viaje entrante") y ahora re-abre como PUJA,
        // avisamos "nueva ronda · ahora es puja" (BidsScreen lo muestra) para que el conductor entienda que
        // es el mismo viaje con otra mecánica, no una oferta random. `getState()` lee el valor actual sin
        // suscribir. Va ANTES del clearOffer (que borra el incomingOffer que estamos comparando).
        const flippedFromFixed =
          useDispatchStore.getState().incomingOffer?.tripId === payload.tripId;
        clearOffer();
        if (flippedFromFixed) {
          setPujaRebidNotice(payload.tripId);
        }
        queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY });
        if (!activeTripId) {
          navigateToBids();
        }
        return;
      }
      // Oferta FIXED (por defecto): el conductor debe aceptar/rechazar antes de `expiresAt`.
      setIncomingOffer({
        matchId: payload.matchId,
        tripId: payload.tripId,
        expiresAt: payload.expiresAt,
        scheduled,
      });
      navigateToIncoming({ matchId: payload.matchId, tripId: payload.tripId });
    },
    onMatch: (payload) => {
      // Match confirmado: cualquier oferta FIXED entrante colgada en el store ya no aplica (o ganamos por
      // puja, sin pasar por TripIncoming). La limpiamos para no dejar un "Viaje entrante" fantasma tras el match.
      clearOffer();
      // ADR-020 Lote 2 (2b) — GANAMOS esta puja: el "esperando al pasajero…" ya cumplió su función; lo
      // limpiamos (navegamos a TripActive abajo). Idempotente si el tripId no estaba pendiente (flujo FIXED).
      clearPendingBid(payload.tripId);
      setActiveTripId(payload.tripId);
      queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
      // Match confirmado → llevamos al conductor a su viaje. Clave en PUJA (ganó la puja, no pasó por
      // TripIncoming) y si el match llega estando en otra pantalla. En FIXED ya está en TripActive (el
      // accept navega): navegar a la misma ruta+params es no-op, así que es seguro en ambos flujos.
      navigateToTripActive(payload.tripId);
    },
    // ADR-020 Lote 2 (2a) — la puja se cerró para este conductor (el pasajero eligió a otro, o quedó
    // inelegible): removemos la card de la cache al INSTANTE (sin esperar el poll de 12s) y limpiamos el
    // "esperando al pasajero" (2b). El invalidate confirma la lista contra el servidor. Así el conductor
    // nunca tapea una card muerta (que daría 409); la puja simplemente desaparece.
    onBidClosed: (payload) => {
      clearPendingBid(payload.tripId);
      queryClient.setQueryData<OpenBid[]>(BIDS_QUERY_KEY, (old) =>
        old ? old.filter((b) => b.tripId !== payload.tripId) : old,
      );
      queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY });
    },
    onTripUpdate: () => {
      queryClient.invalidateQueries({ queryKey: TRIP_QUERY_PREFIX });
      queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
    },
    // Chat con el pasajero (Ola 2A): el `chat:message` se empuja al store de chat aunque la pantalla
    // de chat no esté montada, para alimentar el badge de no leídos del viaje activo. El store ignora
    // duplicados por `id`, así que el eco del propio POST no se contabiliza dos veces.
    onChatMessage: (message) => {
      receiveMessage(message);
    },
    // Propina en vivo (100% del conductor): guardamos el aviso efímero para el banner del dashboard e
    // invalidamos ganancias, así el neto acumulado refleja el monto real (la verdad vive en el server).
    onTipAdded: (payload) => {
      setTip({ tripId: payload.tripId, tipCents: payload.tipCents });
      // Invalida AMBAS vistas de ganancias (resumen + desglose): la propina entra al neto y al detalle.
      // Antes solo el resumen → la pantalla de Ganancias (breakdown) quedaba desactualizada.
      queryClient.invalidateQueries({ queryKey: EARNINGS_SUMMARY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: EARNINGS_BREAKDOWN_QUERY_KEY });
    },
    // Parada propuesta por el pasajero (Lote C4): se guarda en el store; la pantalla del viaje activo la
    // ofrece para aceptar/rechazar. Solo la mostramos si es del viaje activo (defensa contra cruces).
    onWaypointProposed: (message) => {
      if (message.tripId === activeTripId) {
        setWaypointProposal(message);
      }
    },
    // Estado de la conexión `/driver`: alimenta el indicador de las pantallas (viaje activo / dispatch).
    onConnectionChange: (connected) => {
      setConnected(connected);
    },
    // RECUPERACIÓN tras RECONECTAR: el namespace `/driver` NO reemite el último snapshot (no hay
    // `resync` server-side como en `/passenger`), así que recuperamos por REST lo que se perdió durante
    // el corte (túnel, zona muerta). Invalidamos las queries de viaje (prefijo `['trip']` ⇒ cubre el
    // detalle del activo Y la rehidratación `['trip','active']`), las PUJAS/dispatch en vuelo y el
    // estado de turno. React Query refetchea solo las queries OBSERVADAS (montadas), sin pedir en vano.
    onResync: () => {
      queryClient.invalidateQueries({ queryKey: TRIP_QUERY_PREFIX });
      queryClient.invalidateQueries({ queryKey: BIDS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: SHIFT_STATE_QUERY_KEY });
    },
    // SINGLE ACTIVE SESSION: el conductor inició sesión en OTRO dispositivo → cerramos la sesión local.
    // `expireSession` (no `logout`): la sesión remota YA la revocó el login nuevo (identity); acá solo
    // limpiamos el estado local y volvemos al login. No re-suscribimos el socket (el server rechaza este
    // `sid` viejo, así que no hay guerra de reconexión).
    onSessionSuperseded: () => {
      useSessionStore.getState().expireSession();
    },
    // ENFORCEMENT DE REVOCACIÓN: el gateway rechazó el handshake porque la sesión está revocada (logout
    // remoto, suspensión, o superada). Mismo destino que `superseded`: `expireSession` limpia el estado
    // local y vuelve al login. La revocación server-side ya la aplicó identity (el refresh también fallará).
    onSessionRevoked: () => {
      useSessionStore.getState().expireSession();
    },
  });

  useLocationPublisher(socket, onShift);

  return null;
};
