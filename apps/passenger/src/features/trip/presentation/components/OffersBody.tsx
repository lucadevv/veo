import type {OfferView} from '@veo/api-client';
import {
  Avatar,
  Banner,
  Button,
  Card,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {
  formatDurationMinutes,
  formatPEN,
} from '../../../../shared/utils/format';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {IconStarFilled} from './icons';

/**
 * ADR-021 Fase J (J1) · Ventana de búsqueda AUTORITATIVA, sin número inventado. El countdown es
 * VISUAL/HONESTO: NO decide la fase (la fase `noOffers` la activa SOLO el backend al EXPIRAR el board →
 * trip.expired → resolveTripPhase). Cuando llega a 0 NO mostramos botón roto: spinner honesto + esperamos.
 *
 * CLAVE (J1 — mató el bug de los "3 tiempos"): el countdown se deriva ÚNICAMENTE de `board.expiresAt`
 * (epoch ms, autoritativo del server). Ya NO hay fallback local de 60s: en PUJA el board manda; en FIXED
 * (o mientras el board todavía no llegó) NO hay UN deadline honesto que mostrar (las ofertas son
 * secuenciales), así que `hasWindow=false` → la UI muestra "Buscando conductor…" INDETERMINADO, sin número
 * y sin el salto que se veía cuando el reloj local (arrancado en otro instante) era reemplazado por el real.
 */

/** mm:ss para el countdown visual (clamp a 0, nunca negativo). */
function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * Countdown de la ventana de búsqueda, derivado SOLO del `board.expiresAt` autoritativo (epoch ms).
 * `hasWindow=false` cuando NO hay board (FIXED, o aún no llegó) → el caller muestra el estado indeterminado
 * en vez de un número inventado. Tickea cada segundo hasta 0. UI pura: el caller lo usa solo para el copy.
 */
function useSearchCountdown(
  active: boolean,
  expiresAt: number | null,
): {secondsLeft: number; elapsed: boolean; hasWindow: boolean} {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const hasWindow = expiresAt != null;

  useEffect(() => {
    if (!active || expiresAt == null) {
      setSecondsLeft(0);
      return;
    }
    const tick = (): void => {
      // AUTORITATIVO y ÚNICO: cuánto falta para el vencimiento REAL del board. Sin fallback local.
      setSecondsLeft(Math.max(0, (expiresAt - Date.now()) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, expiresAt]);

  // `elapsed` solo tiene sentido cuando HAY ventana; sin board nunca está "agotado", está indeterminado.
  return {secondsLeft, elapsed: hasWindow && secondsLeft <= 0, hasWindow};
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
  const {t} = useTranslation();

  // F1 · countdown VISUAL de la búsqueda, activo solo mientras buscamos de verdad (sin ofertas, no
  // expirado, sin error/carga). No decide la fase: cuando el backend confirma EXPIRED, el screen pasa
  // a `noOffers` y desmonta este cuerpo.
  const searching = !isError && !isLoading && !expired && offers.length === 0;
  const {secondsLeft, elapsed, hasWindow} = useSearchCountdown(
    searching,
    expiresAt,
  );

  const body = isError ? (
    <ErrorState onRetry={onRetry} />
  ) : isLoading && offers.length === 0 ? (
    <LoadingState lines={3} />
  ) : offers.length === 0 ? (
    expired ? (
      <EmptyState
        title={t('offers.noneTitle')}
        subtitle={t('offers.noneBody')}
      />
    ) : !hasWindow ? (
      // J1 · SIN board autoritativo (FIXED, o el board aún no llegó): estado INDETERMINADO, sin número
      // inventado. En FIXED las ofertas son secuenciales → no hay UN deadline honesto que mostrarle al
      // pasajero; mostramos "Buscando conductor…" con spinner. Cuando el board PUJA llegue con su
      // `expiresAt`, recién ahí aparece el countdown real (sin el salto del viejo reloj local de 60s).
      <View style={styles.takingLong}>
        <ActivityIndicator color={theme.colors.accent} />
        <EmptyState
          title={t('offers.searchingTitle')}
          subtitle={t('offers.waitingBody')}
        />
      </View>
    ) : elapsed ? (
      // Countdown agotado pero el backend aún no confirmó EXPIRED: spinner HONESTO, sin botón roto.
      // Esperamos la verdad del server (el sweeper expira el board + margen) → luego fase noOffers.
      <View style={styles.takingLong}>
        <ActivityIndicator color={theme.colors.accent} />
        <EmptyState
          title={t('offers.takingLongTitle')}
          subtitle={t('offers.takingLongBody')}
        />
      </View>
    ) : (
      <EmptyState
        title={t('offers.waitingCountdown', {
          time: formatCountdown(secondsLeft),
        })}
        subtitle={t('offers.waitingBody')}
      />
    )
  ) : (
    <View style={{gap: theme.spacing.sm}}>
      {offers.map(offer => (
        <OfferCard
          key={offer.driverId}
          offer={offer}
          onChoose={() => onChoose(offer)}
          choosing={choosing}
        />
      ))}
    </View>
  );

  return (
    <View style={{gap: theme.spacing.md}}>
      <View style={styles.header}>
        <View style={{flex: 1}}>
          {/* ADR-020 Lote 3: el título "N conductores respondieron" + el hint de comparación SOLO cuando
              YA hay ofertas. Buscando (0 ofertas) mostraba "0 conductores respondieron" sobre el
              "Buscando conductores…" del body → redundante y confuso; ahí el pill "En vivo" alcanza. */}
          {offers.length > 0 ? (
            <>
              <Text variant="title3">
                {t('offers.title', {count: offers.length})}
              </Text>
              <Text variant="footnote" color="inkMuted">
                {t('offers.chooseHint')}
              </Text>
            </>
          ) : (
            <Text variant="title3">{t('offers.searchingTitle')}</Text>
          )}
        </View>
        <StatusPill
          label={connected ? t('offers.live') : t('offers.reconnecting')}
          tone={connected ? 'brand' : 'neutral'}
          dot
          live={connected && !expired}
        />
      </View>

      {body}

      {actionError ? (
        <Banner tone="danger" title={t('offers.actionError')} />
      ) : null}

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
  const {t} = useTranslation();
  const acceptsPrice = offer.kind === 'ACCEPT_PRICE';

  return (
    <Card
      variant="outlined"
      padding="md"
      style={acceptsPrice ? {borderColor: theme.colors.accent} : undefined}>
      <View style={styles.row}>
        <Avatar size="md" />
        <View style={{flex: 1, gap: theme.spacing.xxs}}>
          <View style={styles.nameRow}>
            <Text variant="bodyStrong">
              {offer.driverName ?? t('offers.driver')}
            </Text>
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
            {acceptsPrice
              ? t('offers.acceptsPrice')
              : t('offers.proposesOther')}{' '}
            ·{' '}
            {t('offers.etaMin', {
              minutes: formatDurationMinutes(offer.etaSeconds),
            })}
          </Text>
        </View>
        <View style={{alignItems: 'flex-end', gap: theme.spacing.xs}}>
          <Text
            variant="title3"
            color={acceptsPrice ? 'accent' : 'ink'}
            tabular>
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
  header: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  takingLong: {alignItems: 'center', gap: 8},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  ratingRow: {flexDirection: 'row', alignItems: 'center', gap: 3},
});
