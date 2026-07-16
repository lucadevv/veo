import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, StatusPill, Text } from '@veo/ui-kit';
import { formatPEN } from '../../../../shared/presentation/format';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { OfferStepper } from '../../../../shared/presentation/components/OfferStepper';
import { CountdownRing } from '../../../trips/presentation/components/CountdownRing';
import { BID_MAX_CENTS, clampCounter, type OpenBid } from '../../domain';
import { useAcceptBid, useCounterBid } from '../hooks/useBids';
import { isBidGoneError } from '../bid-errors';
import { useCountdownMs } from '../../../../shared/presentation/hooks/useCountdownMs';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';

interface Props {
  bid: OpenBid | null;
  /** La puja desapareció de la lista viva (otro conductor la tomó / venció): se muestra "ya no disponible". */
  gone?: boolean;
  onClose: () => void;
}

/** Paso del stepper de contraoferta: S/ 1. */
const COUNTER_STEP_CENTS = 100;

/** Contraoferta inicial al entrar al modo: un paso sobre el bid (clampeada al rango válido). */
function initialCounterCents(bidCents: number): number {
  return clampCounter(bidCents + COUNTER_STEP_CENTS, bidCents);
}

/**
 * Sheet de respuesta a una puja: el conductor ACEPTA la tarifa tal cual o CONTRAOFERTA un precio mayor.
 * La contraoferta se arma con el stepper −/+ del board (frame C/Puja: círculos de 52 + chips de salto
 * rápido) en vez de un teclado libre: el rango [bid + paso, techo] queda garantizado por construcción,
 * así que no hay estado inválido que validar en el cliente. El gate AUTORITATIVO sigue en dispatch.
 */
export const CounterOfferSheet = ({ bid, gone = false, onClose }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const accept = useAcceptBid();
  const counter = useCounterBid();
  // ADR-020 Lote 2 (2b) — pendiente "esperando al pasajero". El estado vive en el store (sesión en vivo):
  // así sobrevive a cerrar/reabrir el sheet, y el realtime lo limpia al GANAR (onMatch) o PERDER (bid:closed).
  const addPendingBid = useDispatchStore((s) => s.addPendingBid);
  const pending = useDispatchStore((s) => bid !== null && s.pendingBidTripIds.includes(bid.tripId));

  const [mode, setMode] = useState<'view' | 'counter'>('view');
  const [counterCents, setCounterCents] = useState(0);

  // Al abrir otra puja (o cerrar), reinicia el modo/el monto y limpia el estado de las mutaciones.
  useEffect(() => {
    setMode('view');
    setCounterCents(bid ? initialCounterCents(bid.bidCents) : 0);
    accept.reset();
    counter.reset();
    // Solo cuando cambia la puja objetivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid?.tripId]);

  const secondsLeft = useCountdownMs(bid?.expiresAt ?? 0);
  const expired = Boolean(bid) && secondsLeft <= 0;

  // Fracción del anillo: el mayor valor observado del countdown es el denominador (la ventana real).
  const maxSecondsRef = useRef(0);
  if (secondsLeft > maxSecondsRef.current) {
    maxSecondsRef.current = secondsLeft;
  }
  const progress = maxSecondsRef.current > 0 ? secondsLeft / maxSecondsRef.current : 0;

  // El stepper solo produce montos del rango válido (bid + paso … techo): la única invalidez posible
  // es que la ventana haya vencido.
  const counterValid = counterCents > (bid?.bidCents ?? 0) && !expired;

  // La puja ya no está: desapareció de la lista (otro la tomó/venció) o un submit chocó con un board ya
  // cerrado (409/404). En ese caso NO ofrecemos aceptar/contraofertar — solo informamos y dejamos cerrar.
  const goneByError = isBidGoneError(accept.error) || isBidGoneError(counter.error);
  const unavailable = gone || goneByError;

  // 2b — tras enviar la oferta NO cerramos el sheet: entramos a "esperando al pasajero…" (honesto: la
  // oferta está ENVIADA, no ganada). El desenlace llega por el socket: gana → onMatch navega a TripActive;
  // pierde → bid:closed limpia el pendiente y remueve la card. Marcamos el pendiente en el store.
  const onAccept = () => {
    if (!bid) {
      return;
    }
    accept.mutate(bid, { onSuccess: () => addPendingBid(bid.tripId) });
  };

  const onSendCounter = () => {
    if (!bid || !counterValid) {
      return;
    }
    counter.mutate(
      { bid, priceCents: counterCents },
      { onSuccess: () => addPendingBid(bid.tripId) },
    );
  };

  return (
    <BottomSheet visible={bid !== null} onClose={onClose} title={t('trips.bid.title')} showHandle>
      {bid ? (
        // 2b — puja pendiente (oferta enviada): estado HONESTO "esperando al pasajero…", sin ring ni
        // acciones de aceptar/contraofertar (ya ofertó). Si la puja además murió (unavailable) gana ese
        // aviso: el bloque de abajo ya lo maneja. Solo salida: cerrar (la card queda en la lista con su pill).
        pending && !unavailable ? (
          <View style={styles.body}>
            <StatusPill label={t('trips.bid.pendingPill')} tone="accent" live dot />
            <Banner
              tone="info"
              title={t('trips.bid.waiting')}
              description={t('trips.bid.waitingHint')}
            />
            <Button label={t('common.close')} variant="accent" fullWidth onPress={onClose} />
          </View>
        ) : (
          <View style={styles.body}>
            <View style={styles.ringWrap}>
              <CountdownRing seconds={secondsLeft} progress={progress} expired={expired} />
            </View>

            <View style={styles.amountBlock}>
              <Text variant="subhead" color="inkMuted" align="center">
                {t('trips.bid.subtitle')}
              </Text>
              <Text variant="display" align="center" tabular>
                {formatPEN(bid.bidCents)}
              </Text>
            </View>

            {bid.specialRequests.length > 0 || (bid.waypointCount ?? 0) > 0 ? (
              <View style={styles.specials}>
                {/* "+N paradas" (solo el conteo) junto a las solicitudes especiales: el conductor decide
                    su oferta sabiendo que el viaje NO es directo. Ausente/0 ⇒ no se pinta. */}
                {(bid.waypointCount ?? 0) > 0 ? (
                  <StatusPill
                    label={t('trips.bid.stops', { count: bid.waypointCount })}
                    tone="neutral"
                  />
                ) : null}
                {bid.specialRequests.map((req) => (
                  <StatusPill
                    key={req}
                    label={t(`trips.bid.special.${req}`, { defaultValue: req })}
                    tone="neutral"
                  />
                ))}
              </View>
            ) : null}

            {mode === 'counter' && !unavailable ? (
              // Stepper −/+ del board (C/Puja): monto clampeado por construcción + chips de salto rápido
              // (un paso, dos y cuatro sobre el bid — la escalera 12→14→16 del frame).
              <OfferStepper
                label={t('trips.bid.yourCounter')}
                valueCents={counterCents}
                onChange={setCounterCents}
                minCents={clampCounter(bid.bidCents + COUNTER_STEP_CENTS, bid.bidCents)}
                maxCents={BID_MAX_CENTS}
                stepCents={COUNTER_STEP_CENTS}
                chips={[1, 2, 4].map((steps) =>
                  clampCounter(bid.bidCents + steps * COUNTER_STEP_CENTS, bid.bidCents),
                )}
              />
            ) : null}

            {unavailable ? (
              <Banner tone="danger" title={t('trips.bid.gone')} />
            ) : (
              <>
                {accept.isError ? (
                  <Banner
                    tone="danger"
                    title={t('errors.generic')}
                    description={toErrorMessage(accept.error, t)}
                  />
                ) : null}
                {counter.isError ? (
                  <Banner
                    tone="danger"
                    title={t('errors.generic')}
                    description={toErrorMessage(counter.error, t)}
                  />
                ) : null}
                {expired ? <Banner tone="danger" title={t('trips.bid.expired')} /> : null}
              </>
            )}

            {unavailable ? (
              // Puja muerta: única salida es cerrar (la lista ya se refrescó para soltarla).
              <Button label={t('common.close')} variant="accent" fullWidth onPress={onClose} />
            ) : mode === 'view' ? (
              <View style={styles.actions}>
                <Button
                  label={t('trips.bid.counter')}
                  variant="ghost"
                  disabled={expired}
                  onPress={() => setMode('counter')}
                  style={styles.counterBtn}
                />
                <Button
                  label={t('trips.bid.acceptFare', { amount: formatPEN(bid.bidCents) })}
                  variant="accent"
                  fullWidth
                  disabled={expired || accept.isPending}
                  loading={accept.isPending}
                  onPress={onAccept}
                  style={styles.acceptBtn}
                />
              </View>
            ) : (
              <Button
                label={t('trips.bid.send', { amount: formatPEN(counterCents) })}
                variant="accent"
                fullWidth
                disabled={!counterValid || counter.isPending}
                loading={counter.isPending}
                onPress={onSendCounter}
              />
            )}
          </View>
        )
      ) : null}
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 4 },
  ringWrap: { alignItems: 'center' },
  amountBlock: { gap: 2 },
  specials: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  counterBtn: { flex: 0 },
  acceptBtn: { flex: 1 },
});
