import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
  type StatusTone,
} from '@veo/ui-kit';
import type { BookingRequestView } from '@veo/api-client';
import { bookingState } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN } from '../../../../shared/presentation/format';
import { IconCarpool } from '../../../../shared/presentation/icons';
import { useApproveBooking, useRejectBooking, useTripBookings } from '../hooks/useCarpool';

type Props = NativeStackScreenProps<RootStackParamList, 'CarpoolTripBookings'>;

/** `estado` es el union TIPADO del contrato (`bookingState`): switch EXHAUSTIVO, cero strings mágicos. */
function bookingTone(estado: BookingRequestView['estado']): StatusTone {
  switch (estado) {
    case 'SOLICITADO':
    case 'PENDIENTE_APROBACION':
      return 'warn';
    case 'APROBADO':
    case 'COBRO_PENDIENTE':
    case 'EN_RUTA':
      return 'accent';
    case 'CONFIRMADO':
    case 'COMPLETADO':
      return 'success';
    case 'RECHAZADO':
    case 'EXPIRADO':
    case 'CANCELADO':
      return 'neutral';
  }
}

function BookingCard({
  booking,
  tripId,
  t,
}: {
  booking: BookingRequestView;
  tripId: string;
  t: TFunction;
}): React.JSX.Element {
  const approve = useApproveBooking();
  const reject = useRejectBooking();
  const pending = booking.estado === bookingState.enum.PENDIENTE_APROBACION;
  const busy = approve.isPending || reject.isPending;

  return (
    <Card variant="filled">
      <View style={styles.head}>
        <Text variant="bodyStrong">{t('carpool.seatsRequested', { count: booking.asientos })}</Text>
        <StatusPill
          label={t(`carpool.bookingState.${booking.estado}`)}
          tone={bookingTone(booking.estado)}
          dot
        />
      </View>
      {booking.mensajeIntro ? (
        <Text variant="callout" color="inkMuted" style={styles.msg}>
          {booking.mensajeIntro}
        </Text>
      ) : null}
      <View style={styles.priceRow}>
        <Text variant="footnote" color="inkSubtle">
          {t('carpool.agreedPrice')}
        </Text>
        <Text variant="bodyStrong" color="success" tabular>
          {formatPEN(booking.precioAcordado)}
        </Text>
      </View>
      {pending ? (
        <View style={styles.actions}>
          <Button
            label={t('carpool.reject')}
            variant="secondary"
            disabled={busy}
            loading={reject.isPending}
            onPress={() => reject.mutate({ bookingId: booking.id, tripId })}
          />
          <Button
            label={t('carpool.approve')}
            variant="accent"
            disabled={busy}
            loading={approve.isPending}
            onPress={() => approve.mutate({ bookingId: booking.id, tripId })}
          />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Solicitudes de un viaje publicado: el conductor ve las reservas entrantes y APRUEBA (dispara el cobro
 * charge-on-approval en booking-service → payment-service) o RECHAZA. El asiento se decrementa recién al
 * CONFIRMAR (tras `payment.captured`), no al aprobar — por eso una aprobada queda "cobrando".
 */
export const CarpoolTripBookingsScreen = ({ route, navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { tripId } = route.params;
  const bookings = useTripBookings(tripId);

  return (
    <SafeScreen
      scroll
      header={<TopBar title={t('carpool.requestsTitle')} onBack={navigation.goBack} />}
    >
      {bookings.isLoading ? (
        <View style={styles.list}>
          <Skeleton height={120} radius={theme.radii.lg} />
          <Skeleton height={120} radius={theme.radii.lg} />
        </View>
      ) : bookings.isError ? (
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(bookings.error, t)}
          action={{ label: t('common.retry'), onPress: () => bookings.refetch() }}
        />
      ) : !bookings.data || bookings.data.length === 0 ? (
        <Reveal style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surface }]}>
            <IconCarpool size={38} color={theme.colors.inkSubtle} strokeWidth={1.8} />
          </View>
          <Text variant="title3" align="center">
            {t('carpool.noRequestsTitle')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {t('carpool.noRequestsBody')}
          </Text>
        </Reveal>
      ) : (
        <View style={styles.list}>
          {bookings.data.map((b, i) => (
            <Reveal key={b.id} delay={i * 40}>
              <BookingCard booking={b} tripId={tripId} t={t} />
            </Reveal>
          ))}
        </View>
      )}
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: { gap: 12, paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  msg: { marginTop: 8 },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
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
