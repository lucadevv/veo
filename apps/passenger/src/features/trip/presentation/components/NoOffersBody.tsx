import {ApiError} from '@veo/api-client';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Banner, Button, Text, useTheme} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {BidPanel} from '../../../../shared/presentation/components/BidPanel';
import {formatPEN} from '../../../../shared/utils/format';
import {BID_STEP_CENTS, stepBidCents} from '../../../../shared/utils/bid';

/**
 * F2 · Re-puja RESILIENTE a la carrera de cierre. Aún con la fase derivada del backend (F1), un tap
 * de "Re-pujar" puede caer en la micro-ventana entre que el countdown llega a 0 y el sweeper marca el
 * board EXPIRED (corre cada ~2s, y la ventana es 60s + margen): ahí el trip sigue REQUESTED y el rebid
 * devuelve 409 CONFLICT ("solo REASSIGNING/EXPIRED"). En vez de un error críptico, reintentamos solito
 * con un backoff corto (el sweeper alcanza a expirar en ≤2 ticks) y solo si PERSISTE mostramos un
 * mensaje honesto. NO reintentamos otros errores (validación/red): esos suben tal cual.
 */
const REBID_CONFLICT_RETRIES = 2;
const REBID_RETRY_BACKOFF_MS = [1200, 2200] as const;

/** true si el error es el 409 de estado del rebid (trip aún REQUESTED, board sin expirar todavía). */
function isRebidStateConflict(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 409 && err.code === 'CONFLICT'
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface NoOffersBodyProps {
  /** Viaje EXPIRED (la puja cerró sin ofertas) que se puede RE-PUJAR (EXPIRED → REQUESTED). */
  tripId: string;
  /**
   * La re-puja entró OK: el viaje volvió a REQUESTED y el board se reabre. El screen reacciona solo
   * (su `status` pasa a REQUESTED → fase 'searching'); este callback es para limpiar lo que el body
   * dejó (p. ej. el ref de hand-off del PUENTE) y dejar fluir la máquina de estados.
   */
  onRebid: () => void;
  /**
   * SALIR: el pasajero abandona la puja expirada. NO hay transición server-side desde EXPIRED salvo
   * RE-PUJAR (ver trip-state-machine.ts: `[EXPIRED]: [REQUESTED]`); EXPIRED queda FUERA de LIVE_STATES,
   * o sea el backend lo abandona por diseño (no se cancela un EXPIRED). Por eso el salir es LOCAL:
   * limpia el viaje y vuelve al home idle. No dispara red (no hay endpoint que aplique).
   */
  onExit: () => void;
}

/**
 * Cuerpo "PUJA sin ofertas" del sheet unificado (fase `noOffers` · EXPIRED, ADR 010 #12 · H6.4).
 * REEMPLAZA a la pantalla aparte `NoOffersScreen`: el flujo del pasajero es UNO y vive ENTERO en el
 * sheet, sin navegar a una pantalla sin salida. La puja cerró sin que nadie aceptara → DOS salidas
 * SIEMPRE visibles, sin estados sin retorno:
 *   - RE-PUJAR: ofrece MÁS (stepper canónico `BidPanel`, piso = oferta actual) → `rebid` reabre el
 *     board (EXPIRED → REQUESTED) → la fase vuelve a 'searching' sola.
 *   - SALIR: abandona la puja expirada (local: limpia y vuelve al home idle).
 *
 * NO BLOQUEA con spinner: el "Salir" está disponible desde el primer frame. El precio de la oferta
 * actual (piso de la re-puja) se trae best-effort vía `getActiveTrip`; mientras llega, el botón
 * "Re-pujar" se muestra SIN precio y deshabilitado, pero el pasajero NUNCA queda atrapado (Salir manda).
 */
export function NoOffersBody({
  tripId,
  onRebid,
  onExit,
}: NoOffersBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const tripRepository = useDependency(TOKENS.tripRepository);
  const rebid = useDependency(TOKENS.rebidUseCase);
  const queryClient = useQueryClient();

  // Oferta actual = piso de la re-puja. Best-effort y NO bloqueante: si falla/tarda, el body igual
  // muestra título + explicación + Salir; el "Re-pujar" se habilita cuando llega el piso. La cache la
  // comparte con el resto del flujo (mismo queryKey ['trip', id, 'active']).
  const tripQuery = useQuery({
    queryKey: ['trip', tripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(tripId),
    enabled: Boolean(tripId),
  });

  const currentBidCents = tripQuery.data?.fareCents;
  const [bidCents, setBidCents] = useState<number | null>(null);

  // La nueva oferta arranca un escalón por encima de la actual (nudge a subir para conseguir conductor).
  useEffect(() => {
    if (currentBidCents !== undefined && bidCents === null) {
      setBidCents(currentBidCents + BID_STEP_CENTS);
    }
  }, [currentBidCents, bidCents]);

  // F2 · la mutación absorbe la carrera de cierre: ante 409 CONFLICT reintenta con backoff corto
  // (dándole al sweeper tiempo de marcar EXPIRED). Cualquier otro error sube tal cual al primer intento.
  // Si tras los reintentos sigue en conflicto, propaga el ApiError 409 → el body muestra el mensaje
  // honesto "closingSearch" (no el error genérico). Al éxito, la fase del screen vuelve a 'searching'
  // sola (status REQUESTED → board nuevo) vía onRebid; acá no navegamos.
  const rebidMutation = useMutation({
    mutationFn: async (amount: number): Promise<void> => {
      let lastConflict: unknown = null;
      for (let attempt = 0; attempt <= REBID_CONFLICT_RETRIES; attempt += 1) {
        try {
          await rebid.execute(tripId, amount);
          return;
        } catch (err) {
          if (!isRebidStateConflict(err)) throw err; // validación/red/etc: no reintentar.
          lastConflict = err;
          if (attempt < REBID_CONFLICT_RETRIES) {
            await sleep(REBID_RETRY_BACKOFF_MS[attempt] ?? 2000);
          }
        }
      }
      throw lastConflict; // se agotaron los reintentos: el board sigue sin expirar.
    },
    onSuccess: () => {
      // El re-bid reabrió el board (EXPIRED → REQUESTED) con un `expiresAt` FRESCO en el server, pero
      // la cache de ['trip', id, 'offers'] todavía tiene el board VIEJO con el expiresAt YA VENCIDO. Sin
      // esto, al volver la fase a 'searching' el OffersBody calcula secondsLeft=0 → pinta el spinner
      // "tardando" en vez del countdown, hasta que el poll de 5s traiga el board nuevo (el bug del
      // "timer ausente al re-pujar"). Fix en dos pasos:
      //  1) LIMPIAR el board de la cache (expiresAt → null): el countdown cae al fallback local de 60s
      //     al instante (useSearchCountdown), así el timer aparece SIN esperar al refetch.
      //  2) INVALIDAR las queries del trip (offers + state) → refetch inmediato: trae el board fresco
      //     (expiresAt autoritativo) y el status REQUESTED → la fase pasa a 'searching' sin lag de 5s.
      queryClient.setQueryData(
        ['trip', tripId, 'offers'],
        (old: {board: unknown; offers: unknown} | undefined) =>
          old ? {...old, board: null} : old,
      );
      void queryClient.invalidateQueries({queryKey: ['trip', tripId]});
      onRebid();
    },
  });

  // Distingue el mensaje: 409 persistente (cerrando la búsqueda anterior) vs error genuino (red/server).
  const rebidConflict =
    rebidMutation.isError && isRebidStateConflict(rebidMutation.error);

  const fareReady = currentBidCents !== undefined && bidCents !== null;

  return (
    <View style={{gap: theme.spacing.lg}}>
      <View style={{gap: theme.spacing.xs}}>
        <Text variant="title3">{t('noOffers.title')}</Text>
        <Text variant="callout" color="inkMuted">
          {fareReady
            ? t('noOffers.body', {price: formatPEN(currentBidCents)})
            : t('noOffers.bodyNoPrice')}
        </Text>
      </View>

      {/* Stepper canónico (mismo que el quote): solo cuando ya sabemos el piso. Sin un spinner que tape
          la pantalla — el bloque de acciones de abajo ya deja salir aunque el piso aún no haya llegado. */}
      {fareReady ? (
        <BidPanel
          bidCents={bidCents}
          floorCents={currentBidCents}
          onDecrement={() =>
            setBidCents(b =>
              stepBidCents(b ?? currentBidCents, -1, currentBidCents),
            )
          }
          onIncrement={() =>
            setBidCents(b =>
              stepBidCents(b ?? currentBidCents, 1, currentBidCents),
            )
          }
        />
      ) : null}

      {rebidMutation.isError ? (
        <Banner
          tone={rebidConflict ? 'warn' : 'danger'}
          title={
            rebidConflict ? t('noOffers.closingSearch') : t('noOffers.error')
          }
        />
      ) : null}

      <View style={{gap: theme.spacing.sm}}>
        <Button
          label={
            fareReady
              ? t('noOffers.rebid', {price: formatPEN(bidCents)})
              : t('noOffers.rebidNoPrice')
          }
          variant="primary"
          fullWidth
          loading={rebidMutation.isPending}
          disabled={!fareReady || rebidMutation.isPending}
          onPress={() =>
            bidCents !== null ? rebidMutation.mutate(bidCents) : undefined
          }
        />
        {/* SIEMPRE visible y accionable, sin depender de ninguna query: el pasajero nunca queda atrapado. */}
        <Button
          label={t('noOffers.exit')}
          variant="ghost"
          fullWidth
          disabled={rebidMutation.isPending}
          onPress={onExit}
        />
      </View>
    </View>
  );
}
