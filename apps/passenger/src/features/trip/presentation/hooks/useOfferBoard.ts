import type { ClientBoardStatus, OfferView, TripStatus } from '@veo/api-client';
import { ApiError } from '@veo/api-client';
import { useMutation, useQuery, type UseMutationResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { mergeOffers } from '../../domain/offers';
import type { LiveTripState } from './usePassengerTripSocket';

/** Estado del BOARD de la puja (contrato nuevo `{ board, offers }`). `null` hasta el primer snapshot. */
export interface OfferBoardState {
  status: ClientBoardStatus;
  /** epoch(ms) de vencimiento de la ventana; `null` si el board ya no existe (GONE). */
  expiresAt: number | null;
}

export interface OfferBoard {
  /**
   * Estado efectivo del viaje (socket o, si cayó, snapshot REST). Sólo el board CANCELLED (cancelación
   * EXPLÍCITA del usuario) re-deriva el estado sin esperar al socket → vuelta al home inmediata. EXPIRED y
   * GONE NO mandan: la fase `noOffers` la decide el trip EXPIRED real (GONE es ambiguo —board aún no abierto
   * por el dispatch async vs TTL—). Las ofertas igual vienen `[]` del server en esos estados (sin zombies).
   */
  status: TripStatus | string | null;
  /** Estado del board de la puja (OPEN/CANCELLED/EXPIRED/CLOSED_MATCHED/GONE). `null` hasta el 1er snapshot. */
  board: OfferBoardState | null;
  /** Ofertas vivas fusionadas (snapshot REST + socket, dedup por driverId, ordenadas). */
  offers: OfferView[];
  /** Socket conectado (para el pill "En vivo / Reconectando"). */
  connected: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  acceptMutation: UseMutationResult<unknown, unknown, string>;
  cancelMutation: UseMutationResult<unknown, unknown, void>;
  /** Hubo un error de acción (accept/cancel) que TODAVÍA se debe mostrar. Se auto-limpia (no queda pegado). */
  actionError: boolean;
}

/**
 * Override de estado efectivo a partir del board. SÓLO el evento EXPLÍCITO del usuario (CANCELLED)
 * re-deriva la fase sin esperar al socket. EXPIRED/GONE NO fuerzan nada: la fase `noOffers` sale
 * EXCLUSIVAMENTE de la verdad del trip (status EXPIRED por `trip:update`/poll), porque GONE es AMBIGUO
 * —puede ser "el board aún no abrió" (race con el dispatch async vía Kafka tras el 201 del POST /trips)
 * o "venció por TTL"— y no puede decidir la fase sin pintar un `noOffers` fantasma instantáneo.
 */
export const TERMINAL_BOARD_STATUS: Record<ClientBoardStatus, TripStatus | string | null> = {
  OPEN: null, // la puja sigue viva → no fuerza nada, manda el socket/poll.
  CANCELLED: 'CANCELLED', // el pasajero canceló → fase `ended` → vuelve al home (sin esperar el socket).
  EXPIRED: null, // ambiguo/redundante: la fase noOffers la decide el trip EXPIRED real (no el board).
  GONE: null, // board inexistente: puede ser "aún no abrió" o TTL → NO fuerza fase; manda el trip real.
  CLOSED_MATCHED: null, // ya hay match → el socket trae ASSIGNED; no lo adivinamos acá.
};

/** Override puro del estado efectivo del viaje según el board (testeable sin render). */
export function resolveBoardOverride(board: OfferBoardState | null): TripStatus | string | null {
  return board ? TERMINAL_BOARD_STATUS[board.status] : null;
}

/** Ventana (ms) que un error de acción permanece visible antes de auto-limpiarse. */
const ACTION_ERROR_TTL_MS = 5_000;

/**
 * Lógica del BOARD de la PUJA (ofertas en vivo + aceptar/cancelar), encapsulada para el flujo unificado
 * (SRP: el screen orquesta la fase, este hook es el board). Fusiona el snapshot REST con el socket y
 * expone el estado efectivo + las mutaciones. NO navega ni decide la fase — eso lo hace el screen con
 * `status`/`offers.length` vía la máquina de estados central.
 *
 * F1 (contrato nuevo): `GET /trips/:id/offers` devuelve `{ board, offers }`. Para la PUJA viva el board
 * sólo re-deriva el estado ante la cancelación EXPLÍCITA del usuario (CANCELLED) → vuelta al home sin
 * esperar al socket. EXPIRED/GONE NO fuerzan fase: GONE es AMBIGUO (el board puede aún no haber abierto —el
 * dispatch lo abre async vía Kafka ~1-2s tras el 201 del POST /trips— o haber vencido por TTL), así que un
 * `noOffers` derivado del board se pintaría INSTANTÁNEAMENTE y luego "volvería" a ofertas. La fase noOffers
 * sale EXCLUSIVAMENTE del trip EXPIRED real (socket `trip:update`/poll de estado). `offers` ya viene `[]`
 * en cualquier estado ≠ OPEN (sin zombies). El board sigue siendo la verdad del accept fallido (404/409):
 * refetch inmediato.
 */
export function useOfferBoard(
  tripId: string | null,
  live: Pick<LiveTripState, 'status' | 'incomingOffers' | 'withdrawnDriverIds' | 'connected'>,
  callbacks: { onAccepted: () => void; onCancelled: () => void },
): OfferBoard {
  const listOffers = useDependency(TOKENS.listOffersUseCase);
  const acceptOffer = useDependency(TOKENS.acceptOfferUseCase);
  const cancelBid = useDependency(TOKENS.cancelBidUseCase);
  const tripRepository = useDependency(TOKENS.tripRepository);

  const offersQuery = useQuery({
    queryKey: ['trip', tripId, 'offers'],
    queryFn: () => listOffers.execute(tripId as string),
    enabled: Boolean(tripId),
    refetchInterval: 5000,
  });

  // Respaldo de ESTADO: si el socket se cae al expirar/cancelar/matchear, el poll REST lo detecta igual.
  const stateQuery = useQuery({
    queryKey: ['trip', tripId, 'state'],
    queryFn: () => tripRepository.getTripState(tripId as string),
    enabled: Boolean(tripId),
    refetchInterval: 5000,
  });

  const board = offersQuery.data?.board ?? null;

  // Estado efectivo: SÓLO la cancelación EXPLÍCITA del usuario (board CANCELLED) re-deriva sin esperar al
  // socket. EXPIRED/GONE NO fuerzan nada (GONE es ambiguo: "aún no abrió" por el dispatch async vía Kafka
  // vs TTL) → la fase noOffers la decide el trip EXPIRED real (socket `trip:update`/poll REST de estado).
  const boardOverride = resolveBoardOverride(board);
  const status = boardOverride ?? live.status ?? stateQuery.data?.status ?? null;

  // F1: las ofertas SÓLO vienen (no vacías) con board OPEN; en cualquier otro estado el server ya manda
  // `[]` → la lista jamás muestra ofertas zombies de una puja muerta.
  const offers = mergeOffers(offersQuery.data?.offers ?? [], live.incomingOffers, live.withdrawnDriverIds);

  // Error de acción VISIBLE con auto-limpieza: hoy quedaba PEGADO (OffersBody.tsx:145) porque colgaba de
  // `mutation.isError`, que persiste hasta el próximo intento. Lo desacoplamos a un flag con TTL: se
  // prende al fallar y se apaga solo a los pocos segundos (o al refetch exitoso de ofertas).
  const [actionError, setActionError] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagActionError = (): void => {
    setActionError(true);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setActionError(false), ACTION_ERROR_TTL_MS);
  };
  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const acceptMutation = useMutation({
    mutationFn: (driverId: string) => acceptOffer.execute(tripId as string, driverId),
    onSuccess: () => {
      setActionError(false);
      callbacks.onAccepted();
    },
    onError: (error) => {
      // F1 · la oferta dejó de ser válida (conductor ya no elegible / board cerrado): 404/409. NO nos
      // quedamos con la oferta zombie clavada en pantalla: refetch INMEDIATO → el board nuevo dice la
      // verdad (offers `[]` + status real) y la UI se re-deriva. Mensaje honesto vía el flag con TTL.
      const httpStatus = error instanceof ApiError ? error.status : null;
      if (httpStatus === 404 || httpStatus === 409) {
        void offersQuery.refetch();
      }
      flagActionError();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelBid.execute(tripId as string),
    onSuccess: () => {
      setActionError(false);
      callbacks.onCancelled();
    },
    onError: () => flagActionError(),
  });

  return {
    status,
    board,
    offers,
    connected: live.connected,
    isLoading: offersQuery.isLoading,
    isError: offersQuery.isError,
    refetch: () => void offersQuery.refetch(),
    acceptMutation,
    cancelMutation,
    actionError,
  };
}
