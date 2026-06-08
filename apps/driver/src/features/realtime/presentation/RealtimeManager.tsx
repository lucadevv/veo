import {useEffect} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {navigateToIncoming} from '../../../navigation/navigationRef';
import {useDi} from '../../../core/di/useDi';
import {SHIFT_STATE_QUERY_KEY} from '../../shift/presentation/hooks/useShift';
import {useShiftState} from '../../shift/presentation/hooks/useShift';
import {isOnShift} from '../../shift/domain';
import {TRIP_QUERY_PREFIX} from '../../trips/presentation/hooks/useTrips';
import {useChatStore} from '../../chat/presentation';
import {useDriverRealtime} from './hooks/useDriverRealtime';
import {useLocationPublisher} from './hooks/useLocationPublisher';
import {useDispatchStore} from './state/dispatchStore';

/**
 * Cablea el realtime del conductor mientras la sesión está activa: conecta el socket `/driver`,
 * enruta ofertas/cambios de estado y activa el publisher de GPS cuando el conductor está en turno.
 * No renderiza UI; navega mediante `navigationRef` (no requiere contexto de pantalla).
 */
export const RealtimeManager = (): null => {
  const queryClient = useQueryClient();
  const {foregroundService} = useDi();
  const setIncomingOffer = useDispatchStore(s => s.setIncomingOffer);
  const setActiveTripId = useDispatchStore(s => s.setActiveTripId);
  const receiveMessage = useChatStore(s => s.receiveMessage);

  const {data: shift} = useShiftState();
  const onShift = shift ? isOnShift(shift.status) : false;

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
      setIncomingOffer({
        matchId: payload.matchId,
        tripId: payload.tripId,
        expiresAt: payload.expiresAt,
        scheduled,
      });
      navigateToIncoming({matchId: payload.matchId, tripId: payload.tripId});
    },
    onMatch: payload => {
      setActiveTripId(payload.tripId);
      queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY});
    },
    onTripUpdate: () => {
      queryClient.invalidateQueries({queryKey: TRIP_QUERY_PREFIX});
      queryClient.invalidateQueries({queryKey: SHIFT_STATE_QUERY_KEY});
    },
    // Chat con el pasajero (Ola 2A): el `chat:message` se empuja al store de chat aunque la pantalla
    // de chat no esté montada, para alimentar el badge de no leídos del viaje activo. El store ignora
    // duplicados por `id`, así que el eco del propio POST no se contabiliza dos veces.
    onChatMessage: message => {
      receiveMessage(message);
    },
  });

  useLocationPublisher(socket, onShift);

  return null;
};
