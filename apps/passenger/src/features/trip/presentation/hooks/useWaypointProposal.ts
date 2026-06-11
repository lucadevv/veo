import type { GeoPoint, WaypointProposalOutcome, WaypointProposalView } from '@veo/api-client';
import { WaypointProposalStatus } from '@veo/api-client';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';

/**
 * Fases LOCALES de la propuesta de parada mid-trip (Lote C3), vistas por el pasajero:
 *  - idle        → sin propuesta en curso (botón "Agregar parada" disponible).
 *  - proposing   → POST en vuelo (el server calcula delta/ruta/ETA).
 *  - waiting     → propuesta viva: esperando que el conductor acepte/rechace (cuenta regresiva).
 *  - accepted    → el conductor aceptó (ruta + tarifa cambian; el detalle se refetchea).
 *  - rejected    → el conductor rechazó (el viaje sigue igual).
 *  - expired     → venció antes de respuesta (sin cargo; el viaje sigue igual).
 *  - error       → el POST falló (red/validación); se puede reintentar.
 *
 * `accepted`/`rejected` los entrega el OUTCOME en vivo (socket `/passenger`, Lote C4); `expired` lo
 * resuelve TAMBIÉN un reloj local contra `expiresAt` (degradación honesta si el socket no llega).
 */
export type WaypointProposalPhase =
  | 'idle'
  | 'proposing'
  | 'waiting'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'error';

export interface WaypointProposalController {
  phase: WaypointProposalPhase;
  /** La propuesta viva o recién resuelta (delta, tarifa/ETA nuevos, vencimiento). `null` en idle. */
  proposal: WaypointProposalView | null;
  /** Segundos restantes mientras `waiting`; `null` fuera de esa fase. */
  secondsLeft: number | null;
  /** ¿Está el pasajero ELIGIENDO el punto en el mapa? (el mapa captura el tap mientras esto es true). */
  picking: boolean;
  /** Punto tocado en el mapa durante el picking (preview), o `null` si aún no tocó. */
  pickedPoint: GeoPoint | null;
  /** Arranca la selección del punto en el mapa ("Agregar parada"). */
  startPicking: () => void;
  /** Registra el punto tocado en el mapa (lo llama el `onPress` del mapa). */
  pickPoint: (point: GeoPoint) => void;
  /** Cancela la selección sin proponer (vuelve a idle). */
  cancelPicking: () => void;
  /** Confirma el punto elegido y dispara el POST de la propuesta. */
  confirm: () => void;
  /** Vuelve a `idle` desde un estado terminal o de error (cierra el cartel y reabilita el botón). */
  dismiss: () => void;
}

/** Mapea el estado terminal del outcome (C4) a la fase local. */
function phaseFromOutcome(status: WaypointProposalStatus): WaypointProposalPhase {
  if (status === WaypointProposalStatus.ACCEPTED) return 'accepted';
  if (status === WaypointProposalStatus.REJECTED) return 'rejected';
  return 'expired';
}

/**
 * Máquina LOCAL de la propuesta de parada mid-trip del pasajero. Encapsula el POST (server-authoritative:
 * el cliente NO fija precio), la cuenta regresiva contra `expiresAt`, y la resolución por el OUTCOME en
 * vivo del socket (Lote C4). NO abre socket propio: recibe el `outcome` del socket ya existente
 * (`usePassengerTripSocket`) por parámetro, así hay UNA sola conexión. Solo presentación/estado.
 *
 * @param tripId  viaje en curso (IN_PROGRESS) sobre el que se propone.
 * @param outcome último outcome recibido por el socket `/passenger`, o `null` si aún ninguno (C4).
 */
export function useWaypointProposal(
  tripId: string,
  outcome: WaypointProposalOutcome | null,
): WaypointProposalController {
  const tripRepository = useDependency(TOKENS.tripRepository);

  const [phase, setPhase] = useState<WaypointProposalPhase>('idle');
  const [proposal, setProposal] = useState<WaypointProposalView | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickedPoint, setPickedPoint] = useState<GeoPoint | null>(null);

  const mutation = useMutation({
    mutationFn: (point: GeoPoint) => tripRepository.proposeWaypoint(tripId, point),
    onMutate: () => setPhase('proposing'),
    onSuccess: (view) => {
      setProposal(view);
      setPhase('waiting');
    },
    onError: () => setPhase('error'),
  });

  const { mutate } = mutation;

  const startPicking = useCallback(() => {
    setPickedPoint(null);
    setPicking(true);
  }, []);

  const pickPoint = useCallback((point: GeoPoint) => setPickedPoint(point), []);

  const cancelPicking = useCallback(() => {
    setPicking(false);
    setPickedPoint(null);
  }, []);

  const confirm = useCallback(() => {
    if (!pickedPoint) {
      return;
    }
    setPicking(false);
    mutate(pickedPoint);
  }, [pickedPoint, mutate]);

  const dismiss = useCallback(() => {
    setPhase('idle');
    setProposal(null);
    setSecondsLeft(null);
    setPicking(false);
    setPickedPoint(null);
  }, []);

  // Cuenta regresiva: mientras `waiting`, recalcula los segundos contra `expiresAt` cada segundo; al
  // llegar a 0 sin respuesta, cae a `expired` (el sweeper del server vence la propuesta en paralelo).
  useEffect(() => {
    if (phase !== 'waiting' || !proposal) {
      return;
    }
    const expiresAtMs = Date.parse(proposal.expiresAt);
    const tick = (): void => {
      const remaining = Math.ceil((expiresAtMs - Date.now()) / 1000);
      if (remaining <= 0) {
        setSecondsLeft(0);
        setPhase('expired');
        return;
      }
      setSecondsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, proposal]);

  // OUTCOME en vivo (C4): si llega un terminal para LA propuesta vigente, resuelve la fase. Se ignora
  // un outcome de otra propuesta (proposalId distinto) o si ya no estamos esperando (anti-carrera).
  const lastOutcomeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!outcome || phase !== 'waiting' || !proposal) {
      return;
    }
    if (outcome.proposalId !== proposal.proposalId) {
      return;
    }
    if (lastOutcomeRef.current === outcome.proposalId) {
      return;
    }
    lastOutcomeRef.current = outcome.proposalId;
    setPhase(phaseFromOutcome(outcome.status));
  }, [outcome, phase, proposal]);

  return {
    phase,
    proposal,
    secondsLeft,
    picking,
    pickedPoint,
    startPicking,
    pickPoint,
    cancelPicking,
    confirm,
    dismiss,
  };
}
