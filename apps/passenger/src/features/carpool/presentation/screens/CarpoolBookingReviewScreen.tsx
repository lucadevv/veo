import type {MobilePaymentMethod} from '@veo/api-client';
import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Banner, Button, Card, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, ScrollView, StyleSheet, TextInput, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {ScreenStateFallback} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN} from '../../../../shared/utils/format';
import {uuidv4} from '../../../../shared/utils/uuid';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  PaymentMethodRow,
  PaymentMethodSheet,
  useIsYapeAutoActive,
} from '../../../payments/presentation';
import {usePaymentPrefsStore} from '../../../payments/presentation/stores/paymentPrefsStore';
import {IconMinus, IconPlus} from '../../../trip/presentation/components/icons';
import {
  CARPOOL_MAX_SEATS,
  CARPOOL_MESSAGE_MAX,
  CARPOOL_MIN_SEATS,
} from '../../domain/entities';
import {formatDayTimeShort} from '../formatDay';
import {useCarpoolBookingStore} from '../stores/carpoolBookingStore';
import {carpoolTripDetailKey} from './CarpoolTripDetailScreen';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Revisión de la reserva (design/veo.pen P/BookingReview): resumen del viaje, stepper de asientos
 * acotado a los DISPONIBLES reales, mensaje al conductor (chips sugeridos + texto libre ≤500),
 * método de pago (mismas piezas canónicas del quoting) y desglose Asiento×N + Total.
 * Diferencias honestas con el pen: NO se pinta la línea "Cargo por servicio S/ 3" (el contrato de
 * reserva no tiene fee: el total es precioBase×asientos, sin montos inventados). La nota de cobro
 * dice la VERDAD del ADR-014: se cobra recién cuando el conductor aprueba.
 */
export function CarpoolBookingReviewScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {tripId, search} =
    useRoute<RouteProp<RootStackParamList, 'CarpoolBookingReview'>>().params;

  const getDetail = useDependency(TOKENS.getCarpoolTripDetailUseCase);
  const reserveSeat = useDependency(TOKENS.reserveCarpoolSeatUseCase);
  const setActiveBooking = useCarpoolBookingStore(s => s.setActiveBooking);
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);

  const [asientos, setAsientos] = useState(CARPOOL_MIN_SEATS);
  const [mensaje, setMensaje] = useState('');
  const [method, setMethod] = useState<MobilePaymentMethod>(defaultMethod);
  const [methodSheetOpen, setMethodSheetOpen] = useState(false);
  const setDefaultMethod = usePaymentPrefsStore(s => s.setDefault);
  // Señal "Yape · automático" (afiliación On-File): solo REFLEJO, el cobro lo decide el server.
  const yapeAutoActive = useIsYapeAutoActive();

  // Idempotency-Key POR SUBMIT: se genera perezosa al primer intento y se REUSA en los reintentos
  // del mismo submit (si el POST falló por red, reintentar con la misma key dedupea server-side en
  // vez de crear una segunda solicitud). Tras el éxito se navega fuera, así que nunca "bloquea"
  // una reserva nueva (otra entrada a esta pantalla = ref fresca).
  const idempotencyKeyRef = useRef<string | null>(null);

  const detailQuery = useQuery({
    queryKey: carpoolTripDetailKey(tripId),
    queryFn: () => getDetail.execute(tripId),
  });

  const reserveMutation = useMutation({
    mutationFn: () => {
      idempotencyKeyRef.current ??= uuidv4();
      return reserveSeat.execute(
        {
          publishedTripId: tripId,
          asientos,
          paymentMethod: method,
          // Recojo/bajada = lo que el pasajero BUSCÓ (su origen/destino), no los del conductor.
          pickupLat: search.originLat,
          pickupLon: search.originLon,
          dropoffLat: search.destLat,
          dropoffLon: search.destLon,
          mensajeIntro: mensaje.trim() === '' ? undefined : mensaje.trim(),
        },
        idempotencyKeyRef.current,
      );
    },
    onSuccess: booking => {
      // Persistimos el booking activo (re-entrada al seguimiento) y REEMPLAZAMOS la pantalla: el
      // "atrás" del estado no debe volver al formulario (evita el doble submit accidental).
      setActiveBooking(booking.id);
      navigation.replace('CarpoolBookingStatus', {bookingId: booking.id});
    },
  });

  if (detailQuery.isLoading) {
    return <ScreenStateFallback loading />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ScreenStateFallback
        errorMessage={t('carpool.detailLoadError')}
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const {trip} = detailQuery.data;
  const maxSeats = Math.min(trip.asientosDisponibles, CARPOOL_MAX_SEATS);
  const totalCents = trip.precioBase * asientos;

  const appendChip = (text: string): void => {
    setMensaje(current => {
      const joined = current.trim() === '' ? text : `${current.trim()} ${text}`;
      return joined.slice(0, CARPOOL_MESSAGE_MAX);
    });
  };

  return (
    <SafeScreen
      padded={false}
      footer={
        <Button
          label={t('carpool.submitCta')}
          fullWidth
          loading={reserveMutation.isPending}
          onPress={() => reserveMutation.mutate()}
        />
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {/* Resumen del viaje (ruta buscada + salida real del viaje publicado). */}
        <Card variant="outlined" padding="lg">
          <View style={{gap: theme.spacing.xs}}>
            <Text variant="bodyStrong">
              {t('carpool.route', {
                origin: search.originLabel,
                destination: search.destLabel,
              })}
            </Text>
            <Text variant="footnote" color="inkMuted" tabular>
              {formatDayTimeShort(trip.fechaHoraSalida)}
            </Text>
          </View>
        </Card>

        {/* Asientos: stepper acotado a los disponibles REALES. */}
        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead">{t('carpool.reviewSeatsLabel')}</Text>
          <View style={styles.seatControl}>
            <View style={[styles.stepperRow, {gap: theme.spacing.md}]}>
              <StepperButton
                icon={<IconMinus color={theme.colors.ink} size={20} />}
                disabled={asientos <= CARPOOL_MIN_SEATS}
                accessibilityLabel={t('actions.delete')}
                onPress={() => setAsientos(current => current - 1)}
              />
              <Text variant="headline" tabular>
                {asientos}
              </Text>
              <StepperButton
                icon={<IconPlus color={theme.colors.ink} size={20} />}
                disabled={asientos >= maxSeats}
                accessibilityLabel={t('actions.add')}
                onPress={() => setAsientos(current => current + 1)}
              />
            </View>
            <Text variant="footnote" color="inkSubtle">
              {t('carpool.reviewMaxSeats', {count: maxSeats})}
            </Text>
          </View>
        </View>

        {/* Mensaje al conductor: chips sugeridos + texto libre (≤500, límite del wire). */}
        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead">{t('carpool.messageLabel')}</Text>
          <View style={{gap: theme.spacing.sm}}>
            {[t('carpool.chipLightLuggage'), t('carpool.chipBackpack')].map(
              chip => (
                <Pressable
                  key={chip}
                  accessibilityRole="button"
                  accessibilityLabel={chip}
                  onPress={() => appendChip(chip)}
                  style={({pressed}) => [
                    styles.chip,
                    {
                      borderRadius: theme.radii.pill,
                      backgroundColor: theme.colors.surfaceElevated,
                      paddingHorizontal: theme.spacing.lg,
                      paddingVertical: theme.spacing.sm,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}>
                  <Text variant="footnote" color="inkMuted">
                    {`+ ${chip}`}
                  </Text>
                </Pressable>
              ),
            )}
          </View>
          <TextInput
            value={mensaje}
            onChangeText={text =>
              setMensaje(text.slice(0, CARPOOL_MESSAGE_MAX))
            }
            placeholder={t('carpool.messagePlaceholder')}
            placeholderTextColor={theme.colors.inkSubtle}
            multiline
            maxLength={CARPOOL_MESSAGE_MAX}
            accessibilityLabel={t('carpool.messageLabel')}
            style={[
              styles.textarea,
              {
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                color: theme.colors.ink,
                padding: theme.spacing.md,
              },
            ]}
          />
        </View>

        {/* Método de pago: piezas canónicas del quoting (no pisa el default salvo "recordar"). */}
        <View style={{gap: theme.spacing.sm}}>
          <PaymentMethodRow
            method={method}
            autoActive={yapeAutoActive}
            onPress={() => setMethodSheetOpen(true)}
          />
        </View>

        {/* Desglose: Asiento×N + Total (sin "cargo por servicio": no existe en el contrato). */}
        <View style={{gap: theme.spacing.sm}}>
          <View style={styles.breakdownRow}>
            <Text variant="callout" color="inkMuted">
              {t('carpool.breakdownSeat', {count: asientos})}
            </Text>
            <Text variant="callout" tabular>
              {formatPEN(totalCents)}
            </Text>
          </View>
          <View
            style={[styles.divider, {backgroundColor: theme.colors.border}]}
          />
          <View style={styles.breakdownRow}>
            <Text variant="bodyStrong">{t('carpool.total')}</Text>
            <Text variant="headline" tabular>
              {formatPEN(totalCents)}
            </Text>
          </View>
        </View>

        {/* Verdad del ADR-014: el CHARGE se dispara al aprobar; antes no se toca el dinero. */}
        <Banner tone="info" title={t('carpool.chargeNote')} />

        {reserveMutation.isError ? (
          <Banner tone="danger" title={t('carpool.submitError')} />
        ) : null}
      </ScrollView>

      <PaymentMethodSheet
        visible={methodSheetOpen}
        selected={method}
        defaultMethod={defaultMethod}
        yapeAutoActive={yapeAutoActive}
        onClose={() => setMethodSheetOpen(false)}
        onSelect={(selected, remember) => {
          // SIEMPRE aplica a ESTA reserva; solo con "recordar" asciende a default del perfil.
          setMethod(selected);
          if (remember) {
            setDefaultMethod(selected);
          }
          setMethodSheetOpen(false);
        }}
      />
    </SafeScreen>
  );
}

interface StepperButtonProps {
  icon: React.ReactNode;
  disabled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}

/** Botón circular −/+ del stepper (hit-target 44pt), mismo lenguaje que el buscador. */
function StepperButton({
  icon,
  disabled,
  accessibilityLabel,
  onPress,
}: StepperButtonProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.stepperButton,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  seatControl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepperRow: {flexDirection: 'row', alignItems: 'center'},
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {alignSelf: 'flex-start'},
  textarea: {minHeight: 84, borderWidth: 1, textAlignVertical: 'top'},
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
});
