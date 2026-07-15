import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Card,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
  type StatusTone,
} from '@veo/ui-kit';
import type { PublishedTripView } from '@veo/api-client';
import type { MainTabParamList, RootStackParamList } from '../../../../navigation/types';
import { useDriverTabBarHeight } from '../../../../navigation/DriverTabBar';
import { ScreenHero } from '../../../../shared/presentation/components/ScreenHero';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { calendarDaysAgo, formatPEN, formatShortDate } from '../../../../shared/presentation/format';
import { IconCarpool, IconChevronRight, IconPlus } from '../../../../shared/presentation/icons';
import { useMyPublishedTrips } from '../hooks/useCarpool';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Compartir'>,
  NativeStackScreenProps<RootStackParamList>
>;

/**
 * `estado` es el union TIPADO del contrato (`publishedTripState`): switch EXHAUSTIVO, cero strings mágicos
 * (un estado nuevo o mal escrito = error de compilación). Reserva de color: verde = viaje vivo/activo
 * (publicado, parcial, en ruta) y completado; ámbar = LLENO (se llenó, ya no recibe reservas); rojo =
 * cancelado; gris = borrador.
 */
function tripStateTone(estado: PublishedTripView['estado']): StatusTone {
  switch (estado) {
    case 'PUBLICADO':
    case 'PARCIALMENTE_RESERVADO':
    case 'EN_RUTA':
    case 'COMPLETADO':
      return 'success';
    case 'LLENO':
      return 'warn';
    case 'CANCELADO':
      return 'danger';
    case 'BORRADOR':
      return 'neutral';
  }
}

/**
 * Salida del viaje como día relativo + hora ("Hoy · 6:30 p. m." / "Mañana · 8:00 a. m."); para salidas más
 * lejanas cae a la fecha corta + hora. `calendarDaysAgo` cuenta días de calendario respecto de hoy: 0 = hoy,
 * -1 = mañana (la salida es futura). Cabecera de la tarjeta hasta que exista la ruta por nombre (geocoding).
 */
function formatDeparture(iso: string, t: TFunction): string {
  const date = new Date(iso);
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('es-PE', { hour: 'numeric', minute: '2-digit', hour12: true });
  const days = calendarDaysAgo(iso);
  const day = days === 0 ? t('carpool.dayToday') : days === -1 ? t('carpool.dayTomorrow') : formatShortDate(iso);
  return time ? `${day} · ${time}` : day;
}

/** Tarjeta de un viaje publicado del conductor. La RUTA por nombre (geocoding) es un follow-up; hoy el foco
 *  es fecha + asientos + precio + estado. Toca → gestionar las solicitudes de ese viaje. */
function TripCard({
  trip,
  t,
  onPress,
}: {
  trip: PublishedTripView;
  t: TFunction;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card variant="filled">
        <View style={styles.cardHead}>
          <Text variant="bodyStrong" color="accent">
            {formatDeparture(trip.fechaHoraSalida, t)}
          </Text>
          <StatusPill
            label={t(`carpool.state.${trip.estado}`)}
            tone={tripStateTone(trip.estado)}
            dot
          />
        </View>
        <View style={styles.cardMeta}>
          <View style={styles.seats}>
            <IconCarpool size={16} color={theme.colors.inkSubtle} strokeWidth={2} />
            <Text variant="callout" color="inkMuted">
              {t('carpool.seatsLabel', {
                disponibles: trip.asientosDisponibles,
                total: trip.asientosTotales,
              })}
            </Text>
          </View>
          <View style={styles.price}>
            <Text variant="bodyStrong" color="ink" tabular>
              {formatPEN(trip.precioBase)}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('carpool.perSeat')}
            </Text>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

/**
 * Tab "Compartir" — el hogar del carpooling del conductor (marketplace PROGRAMADO, BlaBlaCar-style): publicar
 * viajes + ver los publicados. Es el segundo modo de ganar del híbrido (el otro es Inicio/on-demand). Hereda
 * el chrome editorial (ScreenHero + Reveal) y la paleta jade del resto de la app.
 */
export const CarpoolScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const tabBarHeight = useDriverTabBarHeight();
  const trips = useMyPublishedTrips();

  return (
    <SafeScreen scroll contentContainerStyle={{ paddingBottom: tabBarHeight }}>
      <ScreenHero title={t('carpool.title')} subtitle={t('carpool.subtitle')} />

      {/* CTA "Publicar un viaje" fiel al frame C/Compartir: action-row con círculo + `plus`, etiqueta que
          crece, y chevron — no un botón sólido centrado. */}
      <Reveal delay={40}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('carpool.publishCta')}
          onPress={() => navigation.navigate('CarpoolPublish')}
          style={({ pressed }) => [
            styles.publish,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radii.lg,
              ...theme.elevation.level1,
            },
            pressed && styles.publishPressed,
          ]}
        >
          <View style={[styles.publishIcon, { backgroundColor: theme.colors.brandDim }]}>
            <IconPlus size={22} color={theme.colors.accent} strokeWidth={2.2} />
          </View>
          <View style={styles.publishText}>
            <Text variant="body" style={styles.publishTitle}>
              {t('carpool.publishCta')}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('carpool.publishSubtitle')}
            </Text>
          </View>
          <IconChevronRight size={18} color={theme.colors.accent} />
        </Pressable>
      </Reveal>

      {trips.isLoading ? (
        <View style={styles.section}>
          <Skeleton height={92} radius={theme.radii.lg} />
          <Skeleton height={92} radius={theme.radii.lg} />
        </View>
      ) : trips.isError ? (
        <View style={styles.section}>
          <StateView
            title={t('errors.generic')}
            description={toErrorMessage(trips.error, t)}
            action={{ label: t('common.retry'), onPress: () => trips.refetch() }}
          />
        </View>
      ) : !trips.data || trips.data.length === 0 ? (
        <Reveal delay={80} style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceMuted }]}>
            <IconCarpool size={38} color={theme.colors.inkSubtle} strokeWidth={1.8} />
          </View>
          <Text variant="title3" align="center">
            {t('carpool.emptyTitle')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {t('carpool.emptyBody')}
          </Text>
        </Reveal>
      ) : (
        <View style={styles.section}>
          <Text variant="subhead" color="inkMuted">
            {t('carpool.publishedSection')}
          </Text>
          {trips.data.map((trip, i) => (
            <Reveal key={trip.id} delay={80 + i * 40}>
              <TripCard
                trip={trip}
                t={t}
                onPress={() => navigation.navigate('CarpoolTripBookings', { tripId: trip.id })}
              />
            </Reveal>
          ))}
        </View>
      )}
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  publish: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  publishPressed: { opacity: 0.85 },
  publishIcon: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  publishText: { flex: 1, gap: 2 },
  publishTitle: { fontWeight: '600' },
  section: { gap: 12, paddingTop: 20 },
  seats: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  price: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  empty: { alignItems: 'center', gap: 10, paddingTop: 48 },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
});
