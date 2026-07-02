import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, StatusPill, Text, useTheme } from '@veo/ui-kit';
import { formatPEN } from '../../../../shared/presentation/format';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { CountdownRing } from '../../../trips/presentation/components/CountdownRing';
import { BID_MAX_CENTS, type OpenBid } from '../../domain';
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

/** Convierte un texto en soles ("18.50" o "18,50") a céntimos enteros; NaN si no es un número válido. */
function solesToCents(text: string): number {
  const soles = Number.parseFloat(text.replace(',', '.').trim());
  if (!Number.isFinite(soles)) {
    return NaN;
  }
  return Math.round(soles * 100);
}

/**
 * Sheet de respuesta a una puja: el conductor ACEPTA la tarifa tal cual o CONTRAOFERTA un precio mayor.
 * La contraoferta se valida en el cliente (mayor al bid y ≤ techo) antes de habilitar el envío; el gate
 * AUTORITATIVO sigue en dispatch. Clona el patrón visual de TripIncoming: anillo de cuenta atrás cian,
 * monto como foco y acciones [contraofertar (ghost)] · [aceptar (accent)].
 */
export const CounterOfferSheet = ({ bid, gone = false, onClose }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const accept = useAcceptBid();
  const counter = useCounterBid();
  // ADR-020 Lote 2 (2b) — pendiente "esperando al pasajero". El estado vive en el store (sesión en vivo):
  // así sobrevive a cerrar/reabrir el sheet, y el realtime lo limpia al GANAR (onMatch) o PERDER (bid:closed).
  const addPendingBid = useDispatchStore((s) => s.addPendingBid);
  const pending = useDispatchStore(
    (s) => bid !== null && s.pendingBidTripIds.includes(bid.tripId),
  );

  const [mode, setMode] = useState<'view' | 'counter'>('view');
  const [counterText, setCounterText] = useState('');

  // Al abrir otra puja (o cerrar), reinicia el modo/el input y limpia el estado de las mutaciones.
  useEffect(() => {
    setMode('view');
    setCounterText('');
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

  const counterCents = solesToCents(counterText);
  const counterValid =
    Number.isInteger(counterCents) &&
    counterCents > (bid?.bidCents ?? 0) &&
    counterCents <= BID_MAX_CENTS &&
    !expired;

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

          {bid.specialRequests.length > 0 ? (
            <View style={styles.specials}>
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
            <View style={styles.counterBlock}>
              <Text variant="footnote" color="inkMuted">
                {t('trips.bid.yourCounter')}
              </Text>
              <View
                style={[
                  styles.inputRow,
                  { borderColor: theme.colors.border, borderRadius: theme.radii.lg },
                ]}
              >
                <Text variant="title3" color="inkMuted">
                  S/
                </Text>
                <Text variant="title2" tabular style={styles.inputValue}>
                  {counterText.length > 0 ? counterText : '0.00'}
                </Text>
              </View>
              {/* Teclado numérico inline para no depender del foco del sheet sobre el teclado nativo. */}
              <CounterPad
                onDigit={(d) => setCounterText((prev) => appendDigit(prev, d))}
                onClear={() => setCounterText('')}
                onBackspace={() => setCounterText((prev) => prev.slice(0, -1))}
              />
              <Text
                variant="footnote"
                color={counterValid || counterText.length === 0 ? 'inkSubtle' : 'danger'}
              >
                {t('trips.bid.counterHelper', { min: formatPEN(bid.bidCents) })}
              </Text>
            </View>
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
              label={t('trips.bid.send')}
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

/** Agrega un dígito al texto en soles cuidando un único separador decimal y 2 decimales máximo. */
function appendDigit(prev: string, digit: string): string {
  if (digit === '.') {
    return prev.includes('.') ? prev : prev.length === 0 ? '0.' : `${prev}.`;
  }
  const dot = prev.indexOf('.');
  if (dot >= 0 && prev.length - dot > 2) {
    return prev; // ya tiene 2 decimales
  }
  return `${prev}${digit}`;
}

/** Teclado numérico simple (0-9, punto, borrar) para el monto de la contraoferta. */
const CounterPad = ({
  onDigit,
  onBackspace,
  onClear,
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}): React.JSX.Element => {
  const { t } = useTranslation();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  return (
    <View style={styles.pad}>
      {keys.map((k) => (
        <Button
          key={k}
          label={k}
          variant="secondary"
          size="lg"
          onPress={() => (k === '⌫' ? onBackspace() : onDigit(k))}
          onLongPress={k === '⌫' ? onClear : undefined}
          style={styles.padKey}
          accessibilityLabel={k === '⌫' ? t('common.back') : k}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 4 },
  ringWrap: { alignItems: 'center' },
  amountBlock: { gap: 2 },
  specials: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  counterBlock: { gap: 8 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
  },
  inputValue: { flex: 1, textAlign: 'right' },
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  padKey: { width: '31%' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  counterBtn: { flex: 0 },
  acceptBtn: { flex: 1 },
});
