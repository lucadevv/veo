import type {CarpoolBookingView} from '@veo/api-client';
import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  hexAlpha,
  SafeScreen,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {ScreenStateFallback} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  bookingCharged,
  bookingPhase,
  type CarpoolBookingPhase,
} from '../../domain/entities';
import {formatDayTimeShort} from '../../../../shared/utils/formatDay';
import {usePlaceLabel} from '../usePlaceLabel';
import {
  IconCalendarX,
  IconCircleCheck,
  IconHourglass,
} from '../components/icons';
import {useCarpoolBookingStore} from '../stores/carpoolBookingStore';
import {carpoolTripDetailKey} from './CarpoolTripDetailScreen';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Cadencia del poll mientras el conductor no decide (ms). */
const PENDING_POLL_MS = 5000;

/**
 * Estado REAL de MI solicitud de asiento (design/veo.pen P/WaitingApproval · P/BookingApproved ·
 * P/BookingRejected): UNA pantalla que refleja el `bookingState` del server, con poll cada 5s
 * mientras está pendiente. En estado PENDIENTE ofrece "Cancelar solicitud" (POST
 * /carpool/bookings/:id/cancel · el server sella ownership + estado; sin cobro porque el CHARGE
 * solo se dispara al aprobar). Diferencia honesta con el pen: sin "Enviar mensaje al conductor" (no
 * hay canal de chat carpool). El copy de cobro dice la verdad por estado: pendiente = no se cobró
 * nada; aprobado = cobro en proceso; confirmado = cobrado.
 * DEUDA: (backend) falta canal de chat carpool (p.ej. /carpool/bookings/:id/messages) para "Enviar mensaje al conductor" post-reserva. Hoy solo existe mensajeIntro one-shot en la reserva; el chat /trips/:id/messages es solo para viajes normales, no carpool.
 */
export function CarpoolBookingStatusScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {bookingId} =
    useRoute<RouteProp<RootStackParamList, 'CarpoolBookingStatus'>>().params;
  const getBooking = useDependency(TOKENS.getCarpoolBookingUseCase);
  const getDetail = useDependency(TOKENS.getCarpoolTripDetailUseCase);
  const cancelBooking = useDependency(TOKENS.cancelCarpoolBookingUseCase);
  const clearActiveBooking = useCarpoolBookingStore(s => s.clearActiveBooking);
  const queryClient = useQueryClient();

  const bookingKey = ['carpool', 'booking', bookingId] as const;
  const bookingQuery = useQuery({
    queryKey: bookingKey,
    queryFn: () => getBooking.execute(bookingId),
    // Poll SOLO mientras espera la decisión del conductor; en estados decididos se corta.
    refetchInterval: query =>
      query.state.data && bookingPhase(query.state.data.estado) === 'pending'
        ? PENDING_POLL_MS
        : false,
  });

  // Cancelar MI solicitud: el server devuelve la reserva ya en CANCELADO. Sembramos el cache con
  // esa vista para que la pantalla transicione a la variante "no confirmada" al instante (y el poll
  // se corte solo). Si falla, se muestra un Banner de error y el estado sigue PENDIENTE (reintentable).
  const cancelMutation = useMutation({
    mutationFn: () => cancelBooking.execute(bookingId),
    onSuccess: updated => {
      queryClient.setQueryData(bookingKey, updated);
    },
  });

  const booking = bookingQuery.data;
  const phase: CarpoolBookingPhase | null = booking
    ? bookingPhase(booking.estado)
    : null;

  // El viaje publicado aporta lo que el booking no trae (ruta del conductor, salida, precio base).
  const tripQuery = useQuery({
    queryKey: carpoolTripDetailKey(booking?.publishedTripId ?? ''),
    queryFn: () => getDetail.execute(booking?.publishedTripId ?? ''),
    enabled: booking !== undefined,
  });

  // El seguimiento persistido se limpia cuando la solicitud llega a un estado TERMINAL (cobrada o
  // no confirmada); mientras el cobro está en vuelo (APROBADO/COBRO_PENDIENTE) se conserva para
  // poder re-entrar y ver el desenlace.
  useEffect(() => {
    if (booking && (phase === 'rejected' || bookingCharged(booking.estado))) {
      clearActiveBooking();
    }
  }, [booking, phase, clearActiveBooking]);

  if (bookingQuery.isLoading) {
    return <ScreenStateFallback loading />;
  }

  if (bookingQuery.isError || !booking || !phase) {
    return (
      <ScreenStateFallback
        errorMessage={t('carpool.statusLoadError')}
        onRetry={() => bookingQuery.refetch()}
      />
    );
  }

  const trip = tripQuery.data?.trip ?? null;
  const driverName = tripQuery.data?.driver?.name ?? null;
  // Total mostrado = precio acordado POR ASIENTO (base + solicitud especial) × asientos, el mismo
  // criterio del desglose de la revisión. El monto final autoritativo lo fija el server al cobrar.
  const totalCents = booking.precioAcordado * booking.asientos;
  const backHome = (): void => navigation.popToTop();

  if (phase === 'pending') {
    return (
      <PhaseLayout
        emblem="pending"
        title={t('carpool.waitingTitle')}
        body={
          driverName
            ? t('carpool.waitingBodyNamed', {name: driverName})
            : t('carpool.waitingBody')
        }
        // Sin pill "Pendiente": el título ("Esperando aprobación") ya porta el estado — dos
        // portadoras del mismo dato en la misma cabecera (audit de copy).
        summary={
          <SummaryCard booking={booking} trip={trip} totalCents={totalCents} />
        }
        note={<Banner tone="info" title={t('carpool.waitingReassure')} />}
        actions={
          <View style={styles.actionsCol}>
            {cancelMutation.isError ? (
              <Banner tone="danger" title={t('carpool.cancelError')} />
            ) : null}
            <Button
              label={t('carpool.backHome')}
              variant="secondary"
              fullWidth
              onPress={backHome}
            />
            <Button
              label={t('carpool.cancelRequest')}
              variant="ghost"
              fullWidth
              loading={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            />
          </View>
        }
      />
    );
  }

  if (phase === 'approved') {
    return (
      <PhaseLayout
        emblem="approved"
        title={t('carpool.approvedTitle')}
        body={
          driverName
            ? t('carpool.approvedBodyNamed', {name: driverName})
            : t('carpool.approvedBody')
        }
        summary={
          <SummaryCard booking={booking} trip={trip} totalCents={totalCents} />
        }
        note={
          <Banner
            tone="success"
            title={
              bookingCharged(booking.estado)
                ? t('carpool.chargeDone', {amount: formatPEN(totalCents)})
                : t('carpool.chargeProcessing', {
                    amount: formatPEN(totalCents),
                  })
            }
          />
        }
        actions={
          <Button label={t('carpool.backHome')} fullWidth onPress={backHome} />
        }
      />
    );
  }

  // rejected (RECHAZADO/EXPIRADO/CANCELADO): no se concretó y NO hubo cobro (el CHARGE solo se
  // dispara al aprobar — verdad del ADR-014).
  return (
    <PhaseLayout
      emblem="rejected"
      title={t('carpool.rejectedTitle')}
      body={t('carpool.rejectedBody')}
      note={<Banner tone="success" title={t('carpool.noChargeNote')} />}
      summary={<SummaryCard booking={booking} trip={trip} totalCents={null} />}
      actions={
        <View style={styles.actionsCol}>
          <Button
            label={t('carpool.searchOthers')}
            fullWidth
            // El buscador ya no es ruta del stack: es la raíz del tab Compartir (resuelve anidado).
            onPress={() => navigation.navigate('Compartir')}
          />
          <Button
            label={t('carpool.backHome')}
            variant="secondary"
            fullWidth
            onPress={backHome}
          />
        </View>
      }
    />
  );
}

interface PhaseLayoutProps {
  emblem: CarpoolBookingPhase;
  title: string;
  body: string;
  pill?: React.ReactNode;
  summary: React.ReactNode;
  note: React.ReactNode;
  actions: React.ReactNode;
}

/** Esqueleto compartido de las tres variantes: emblema + textos centrados + resumen + nota + CTAs. */
function PhaseLayout({
  emblem,
  title,
  body,
  pill,
  summary,
  note,
  actions,
}: PhaseLayoutProps): React.JSX.Element {
  const theme = useTheme();

  // Emblema semántico (design/veo.pen P/BookingApproved · P/WaitingApproval · P/BookingRejected):
  // éxito = jade SÓLIDO con glifo blanco (onAccent); pendiente = warn tenue; rechazo = danger tenue.
  // En light el bg neutro (surfaceElevated #FFFFFF) se lavaba sobre el fondo #F5F7FA, por eso el halo
  // va teñido con el color semántico (hexAlpha), fiel a los halos del frame (~8-12% alpha).
  const emblemTone =
    emblem === 'approved'
      ? theme.colors.success
      : emblem === 'pending'
        ? theme.colors.warn
        : theme.colors.danger;
  const emblemSolid = emblem === 'approved';
  const glyphColor = emblemSolid ? theme.colors.onAccent : emblemTone;

  return (
    <SafeScreen padded={false} footer={actions}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {padding: theme.spacing.xl, gap: theme.spacing.xl},
        ]}
        showsVerticalScrollIndicator={false}>
        <View
          style={[
            styles.emblem,
            {
              backgroundColor: emblemSolid
                ? emblemTone
                : hexAlpha(emblemTone, 0.12),
            },
          ]}>
          {emblem === 'pending' ? (
            <IconHourglass color={glyphColor} size={40} />
          ) : emblem === 'approved' ? (
            <IconCircleCheck color={glyphColor} size={44} />
          ) : (
            <IconCalendarX color={glyphColor} size={44} />
          )}
        </View>

        <View style={[styles.textGroup, {gap: theme.spacing.sm}]}>
          <Text variant="title2" style={styles.centered}>
            {title}
          </Text>
          <Text variant="callout" color="inkMuted" style={styles.centered}>
            {body}
          </Text>
        </View>

        {pill ?? null}

        {summary}

        {note}
      </ScrollView>
    </SafeScreen>
  );
}

interface SummaryCardProps {
  /** MI reserva (aporta recojo/bajada y asientos). */
  booking: CarpoolBookingView;
  /** Viaje publicado (puede aún estar cargando o no responder: la fila de fecha degrada honesta). */
  trip: {
    fechaHoraSalida: string;
  } | null;
  /** null = no mostrar total (variante rechazada: no hay nada por cobrar). */
  totalCents: number | null;
}

/**
 * Mini-resumen de la solicitud (ruta geocodificada + salida + asientos + total). La RUTA sale del
 * recojo/bajada de MI booking (reverse geocode real); si el geocoder no responde todavía, muestra
 * el fallback genérico en vez de inventar nombres.
 */
function SummaryCard({
  booking,
  trip,
  totalCents,
}: SummaryCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const originLabel = usePlaceLabel(booking.pickupLat, booking.pickupLon);
  const destinationLabel = usePlaceLabel(
    booking.dropoffLat,
    booking.dropoffLon,
  );

  return (
    <Card variant="outlined" padding="lg" style={styles.fullWidth}>
      <View style={{gap: theme.spacing.sm}}>
        <SummaryRow
          label={t('carpool.fieldRoute')}
          value={t('carpool.route', {
            origin: originLabel,
            destination: destinationLabel,
          })}
        />
        {trip ? (
          <SummaryRow
            label={t('carpool.fieldDate')}
            value={formatDayTimeShort(trip.fechaHoraSalida)}
          />
        ) : null}
        <SummaryRow
          label={t('carpool.fieldSeats')}
          value={
            booking.asientos === 1
              ? t('carpool.seatsOne')
              : t('carpool.seatsMany', {count: booking.asientos})
          }
        />
        {totalCents !== null ? (
          <>
            <View
              style={[styles.divider, {backgroundColor: theme.colors.border}]}
            />
            <SummaryRow
              label={t('carpool.total')}
              value={formatPEN(totalCents)}
              strong
            />
          </>
        ) : null}
      </View>
    </Card>
  );
}

interface SummaryRowProps {
  label: string;
  value: string | null;
  strong?: boolean;
}

function SummaryRow({
  label,
  value,
  strong,
}: SummaryRowProps): React.JSX.Element {
  return (
    <View style={styles.summaryRow}>
      <Text variant="footnote" color="inkSubtle">
        {label}
      </Text>
      <Text variant={strong ? 'headline' : 'callout'} tabular={strong}>
        {value ?? ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {flexGrow: 1, alignItems: 'center', justifyContent: 'center'},
  emblem: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textGroup: {alignItems: 'center'},
  centered: {textAlign: 'center'},
  fullWidth: {alignSelf: 'stretch'},
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  actionsCol: {gap: 10},
});
