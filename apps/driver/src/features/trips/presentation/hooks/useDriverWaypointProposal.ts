import {useEffect} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import type {WaypointProposedMsg} from '@veo/api-client';
import {useRepositories} from '../../../../core/di/useDi';
import {useWaypointProposalStore} from '../../../realtime/presentation/state/waypointProposalStore';
import {tripQueryKey} from './useTrips';

export interface DriverWaypointProposalController {
  /** Propuesta entrante para ESTE viaje, o `null` si no hay ninguna viva. */
  proposal: WaypointProposedMsg | null;
  /** ¿Hay un respond en vuelo? (deshabilita los botones para evitar doble-tap). */
  isResponding: boolean;
  /** El último respond falló (red/validación): se puede reintentar. */
  isError: boolean;
  /** Acepta (true) o rechaza (false) la propuesta. Server-authoritative: recalcula tarifa+ruta. */
  respond: (accept: boolean) => void;
}

/**
 * Controlador de la PARADA propuesta del lado CONDUCTOR (Lote C4). Lee la propuesta entrante del store
 * (la setea el RealtimeManager al recibir `waypoint:proposed`), la EXPONE solo si es de ESTE viaje, y
 * resuelve el respond (POST → driver-bff). Al responder con éxito limpia el store e invalida el viaje
 * (la tarifa pudo cambiar si aceptó). Si la propuesta venció (TTL), la descarta sola (el server ya la
 * expiró en paralelo). Una propuesta de otro viaje se ignora (defensa anti-cruce). Solo presentación.
 */
export function useDriverWaypointProposal(tripId: string): DriverWaypointProposalController {
  const {trips} = useRepositories();
  const queryClient = useQueryClient();
  const stored = useWaypointProposalStore(s => s.proposal);
  const clearProposal = useWaypointProposalStore(s => s.clearProposal);

  // Solo es relevante la propuesta de ESTE viaje (el store guarda una sola, pero defendemos el cruce).
  const proposal = stored && stored.tripId === tripId ? stored : null;

  // Vencimiento: si el TTL pasó, la propuesta está muerta (el sweeper del server la expiró). La
  // descartamos para que la tarjeta no quede colgada ofreciendo aceptar algo que ya no existe.
  useEffect(() => {
    if (!proposal) {
      return;
    }
    const remainingMs = Date.parse(proposal.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      clearProposal();
      return;
    }
    const id = setTimeout(clearProposal, remainingMs);
    return () => clearTimeout(id);
  }, [proposal, clearProposal]);

  const mutation = useMutation({
    mutationFn: ({proposalId, accept}: {proposalId: string; accept: boolean}) =>
      trips.respondWaypoint(tripId, proposalId, accept),
    onSuccess: () => {
      clearProposal();
      // Aceptar cambió la tarifa + la ruta del viaje server-side: refrescamos el viaje y la ruta.
      queryClient.invalidateQueries({queryKey: tripQueryKey(tripId)});
    },
  });

  const {mutate} = mutation;
  const respond = (accept: boolean): void => {
    if (proposal) {
      mutate({proposalId: proposal.proposalId, accept});
    }
  };

  return {proposal, isResponding: mutation.isPending, isError: mutation.isError, respond};
}
