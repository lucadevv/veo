import type { OfferView } from '@veo/api-client';
import { Avatar, Banner, Button, Card, StatusPill, Text, useTheme } from '@veo/ui-kit';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { formatDurationMinutes, formatPEN } from '../../../../shared/utils/format';
import { EmptyState, ErrorState, LoadingState } from '../../../../shared/presentation/components/ScreenStates';
import { IconStarFilled } from './icons';

/**
 * F1/F2 · Ventana de búsqueda (default ratificado §9 = 60s, usado SÓLO de fallback). El countdown es
 * VISUAL/HONESTO: NO decide la fase. La fase `noOffers` la activa SOLO el backend cuando el trip pasa a
 * EXPIRED (el sweeper de dispatch marca el board y trip-service emite `trip.expired` → socket
 * `trip:update`/poll REST → resolveTripPhase). Cuando el countdown llega a 0, NO mostramos un botón roto
 * ni nos adelantamos al server (ese fue el bug del reloj local): mostramos un spinner honesto ("esto está
 * tardando…") y ESPERAMOS la verdad del backend (el siguiente poll trae EXPIRED/GONE).
 *
 * F2 · AUTORITATIVO: cuando el board ya nos dio `expiresAt` (epoch ms), el countdown se deriva de ESE
 * vencimiento, no del reloj local — así no adivina ni se desincroniza del server. El fallback al estimado
 * local (60s desde el montaje) sólo aplica mientras el board todavía no llegó.
 */
const SEARCH_WINDOW_SECONDS = 60;

/** mm:ss para el countdown visual (clamp a 0, nunca negativo). */
function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * Countdown de la ventana de búsqueda. F2: si llega `expiresAt` (epoch ms del board), el restante se
 * deriva de ESE vencimiento autoritativo; si no (board aún no llegó), cae al estimado local de 60s desde
 * el montaje. Tickea cada segundo hasta 0. Es UI pura: el caller lo usa solo para el copy. Devuelve los
 * segundos restantes (>= 0) y si la ventana ya se agotó visualmente.
 */
function useSearchCountdown(
  active: boolean,
  expiresAt: number | null,
): { secondsLeft: number; elapsed: boolean } {
  // Ancla del fallback local: el instante de montaje en fase searching, sembrado una sola vez. Sólo se
  // usa mientras el board todavía no entregó su `expiresAt` autoritativo.
  const startRef = useRef<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(SEARCH_WINDOW_SECONDS);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setSecondsLeft(SEARCH_WINDOW_SECONDS);
      return;
    }
    startRef.current ??= Date.now();
    const tick = (): void => {
      const remainingMs =
        expiresAt != null
          ? // AUTORITATIVO: cuánto falta para el vencimiento real del board.
            expiresAt - Date.now()
          : // FALLBACK local: 60s desde el montaje (sólo hasta que el board entregue su expiresAt).
            SEARCH_WINDOW_SECONDS * 1000 - (Date.now() - (startRef.current as number));
      setSecondsLeft(Math.max(0, remainingMs / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, expiresAt]);

  return { secondsLeft, elapsed: secondsLeft <= 0 };
}

export interface OffersBodyProps {
  offers: OfferView[];
  connected: boolean;
  /** La puja expiró (cambia el copy del estado vacío "nadie aceptó" vs "buscando"). */
  expired: boolean;
  /**
   * F2 · vencimiento AUTORITATIVO de la ventana (epoch ms del board) para el countdown. `null` mientras
   * el board todavía no llegó → el countdown cae al estimado local de 60s.
   */
  expiresAt: number | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onChoose: (offer: OfferView) => void;
  choosing: boolean;
  onCancel: () => void;
  cancelling: boolean;
  actionError: boolean;
}

/**
 * Cuerpo "ofertas de la PUJA" del sheet unificado (fases `searching`/`offers`). Lista las ofertas vivas
 * (o el estado de búsqueda/expirado), deja elegir, y ofrece cancelar la puja. SIN mapa ni navegación
 * (los aporta la pantalla unificada; las acciones suben por callbacks). Misma UI/diseño que el board.
 */
export function OffersBody({
  offers,
  connected,
  expired,
  expiresAt,
  isLoading,
  isError,
  onRetry,
  onChoose,
  choosing,
  onCancel,
  cancelling,
  actionError,
}: OffersBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  // F1 · countdown VISUAL de la búsqueda, activo solo mientras buscamos de verdad (sin ofertas, no
  // expirado, sin error/carga). No decide la fase: cuando el backend confirma EXPIRED, el screen pasa
  // a `noOffers` y desmonta este cuerpo.
  const searching = !isError && !isLoading && !expired && offers.length === 0;
  const { secondsLeft, elapsed } = useSearchCountdown(searching, expiresAt);

  const body = isError ? (
    <ErrorState onRetry={onRetry} />
  ) : isLoading && offers.length === 0 ? (
    <LoadingState lines={3} />
  ) : offers.length === 0 ? (
    expired ? (
      <EmptyState title={t('offers.noneTitle')} subtitle={t('offers.noneBody')} />
    ) : elapsed ? (
      // Countdown agotado pero el backend aún no confirmó EXPIRED: spinner HONESTO, sin botón roto.
      // Esperamos la verdad del server (el sweeper expira a los 60s + margen) → luego fase noOffers.
      <View style={styles.takingLong}>
        <ActivityIndicator color={theme.colors.accent} />
        <EmptyState title={t('offers.takingLongTitle')} subtitle={t('offers.takingLongBody')} />
      </View>
    ) : (
      <EmptyState
        title={t('offers.waitingCountdown', { time: formatCountdown(secondsLeft) })}
        subtitle={t('offers.waitingBody')}
      />
    )
  ) : (
    <View style={{ gap: theme.spacing.sm }}>
      {offers.map((offer) => (
        <OfferCard key={offer.driverId} offer={offer} onChoose={() => onChoose(offer)} choosing={choosing} />
      ))}
    </View>
  );

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text variant="title3">{t('offers.title', { count: offers.length })}</Text>
          <Text variant="footnote" color="inkMuted">
            {t('offers.chooseHint')}
          </Text>
        </View>
        <StatusPill
          label={connected ? t('offers.live') : t('offers.reconnecting')}
          tone={connected ? 'brand' : 'neutral'}
          dot
          live={connected && !expired}
        />
      </View>

      {body}

      {actionError ? <Banner tone="danger" title={t('offers.actionError')} /> : null}

      <Button
        label={t('offers.cancel')}
        variant="ghost"
        fullWidth
        loading={cancelling}
        disabled={choosing}
        onPress={onCancel}
      />
    </View>
  );
}

/** Tarjeta de una oferta (rating + vehículo reales, enriquecidos por el BFF; degradación honesta). */
function OfferCard({
  offer,
  onChoose,
  choosing,
}: {
  offer: OfferView;
  onChoose: () => void;
  choosing: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const acceptsPrice = offer.kind === 'ACCEPT_PRICE';

  return (
    <Card variant="outlined" padding="md" style={acceptsPrice ? { borderColor: theme.colors.accent } : undefined}>
      <View style={styles.row}>
        <Avatar size="md" />
        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
          <View style={styles.nameRow}>
            <Text variant="bodyStrong">{offer.driverName ?? t('offers.driver')}</Text>
            {offer.rating != null ? (
              <View style={styles.ratingRow}>
                <IconStarFilled color={theme.colors.warn} size={13} />
                <Text variant="footnote" color="warn" tabular>
                  {offer.rating.toFixed(2)}
                </Text>
              </View>
            ) : null}
          </View>
          {offer.vehicle ? (
            <Text variant="footnote" color="inkMuted">
              {`${offer.vehicle.make} ${offer.vehicle.model} · ${offer.vehicle.color}`}
            </Text>
          ) : null}
          <Text variant="footnote" color={acceptsPrice ? 'safe' : 'inkMuted'}>
            {acceptsPrice ? t('offers.acceptsPrice') : t('offers.proposesOther')} ·{' '}
            {t('offers.etaMin', { minutes: formatDurationMinutes(offer.etaSeconds) })}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
          <Text variant="title3" color={acceptsPrice ? 'accent' : 'ink'} tabular>
            {formatPEN(offer.priceCents)}
          </Text>
          <Button
            label={acceptsPrice ? t('offers.choose') : t('offers.view')}
            variant="primary"
            size="sm"
            loading={choosing && acceptsPrice}
            disabled={choosing}
            onPress={onChoose}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  takingLong: { alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
