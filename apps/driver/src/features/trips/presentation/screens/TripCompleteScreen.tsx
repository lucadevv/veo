import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, TextField, useTheme } from '@veo/ui-kit';
import { ApiError } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { formatPEN, formatPersonName } from '../../../../shared/presentation/format';
import { IconCheck } from '../../../../shared/presentation/icons';
import type { DriverProfile } from '../../../profile/domain';
import { PROFILE_QUERY_KEY } from '../../../profile/domain';
import { StarRating } from '../../../ratings/presentation';
import { useMyTripRating, useRatePassenger } from '../hooks/usePassengerRating';
import { commissionPercent, computeTripEarnings } from '../../domain';
import { Appear } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripComplete'>;


/**
 * Cierre del viaje del conductor (frame C/TripComplete): resumen de ganancia (tarifa − comisión = neto)
 * + calificación al pasajero (1-5 + comentario opcional). "Listo" envía la calificación (si eligió
 * estrellas) y vuelve al dashboard; sin estrellas, el rating es opcional y "Listo" cierra igual.
 *
 * El monto sale del `fareCents` del viaje (`driverTripView`) descompuesto por `computeTripEarnings`
 * (mismo modelo bruto − comisión de la pantalla de Ganancias) porque el agregado del período aún no se
 * recompuso al cerrar. El nombre del conductor se LEE de la caché del perfil (sin disparar un fetch); si
 * no está, el saludo degrada a genérico. El nombre del pasajero no viaja en el contrato del viaje
 * (regla #5, PII) → la pregunta degrada a "¿Cómo estuvo tu pasajero?".
 */
export const TripCompleteScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { tripId, passengerId, fareCents, passengerName } = route.params;

  const earnings = computeTripEarnings(fareCents);

  // Nombre del conductor desde la caché del perfil (no fuerza red). Solo el primer nombre para el saludo.
  const cachedName = queryClient.getQueryData<DriverProfile>(PROFILE_QUERY_KEY)?.fullName ?? null;
  const firstName = formatPersonName(cachedName)?.split(' ')[0] ?? null;
  const subtitle = firstName
    ? t('trips.complete.subtitleNamed', { name: firstName })
    : t('trips.complete.subtitle');
  const rateTitle = passengerName
    ? t('trips.complete.ratePassengerNamed', { name: passengerName })
    : t('trips.complete.ratePassenger');

  const myRating = useMyTripRating(tripId);
  const rate = useRatePassenger(tripId);

  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');

  // "Ya calificado" = lo trae el servidor (re-entrada) o el envío recién exitoso. En ese estado, las
  // estrellas quedan de solo lectura y no se re-envía.
  const persisted = myRating.data ?? (rate.isSuccess ? rate.data : null);
  const settled = persisted != null;
  const shownStars = persisted ? persisted.stars : stars;
  const canEdit = !settled;

  const finish = (): void => navigation.popToTop();

  const onDone = (): void => {
    // Rating OPCIONAL: sin estrellas (o ya calificado), "Listo" cierra directo al dashboard.
    if (settled || stars < 1) {
      finish();
      return;
    }
    rate.mutate(
      { tripId, passengerId, stars, comment },
      {
        onSuccess: finish,
        // 409 = el viaje ya estaba calificado (doble-tap / re-entrada): éxito disfrazado, cerramos igual.
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            finish();
          }
        },
      },
    );
  };

  const rateFailed = rate.isError && !(rate.error instanceof ApiError && rate.error.status === 409);

  return (
    <SafeScreen
      footer={
        <Button
          label={t('trips.complete.done')}
          fullWidth
          loading={rate.isPending}
          onPress={onDone}
        />
      }
    >
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Appear style={styles.hero}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: `${theme.colors.success}26`,
                borderColor: theme.colors.success,
                shadowColor: theme.colors.success,
              },
            ]}
          >
            <IconCheck size={40} color={theme.colors.success} strokeWidth={3} />
          </View>
          <Text variant="title2" align="center">
            {t('trips.complete.title')}
          </Text>
          <Text variant="footnote" color="inkSubtle" align="center">
            {subtitle}
          </Text>
        </Appear>

        <View style={styles.earn}>
          <Text variant="label" color="inkSubtle">
            {t('trips.complete.earningsLabel')}
          </Text>
          <Text variant="display" tabular style={{ color: theme.colors.accentStrong }}>
            {formatPEN(earnings.netCents)}
          </Text>
        </View>

        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.lg,
              padding: theme.spacing.lg,
              gap: 10,
            },
          ]}
        >
          <BreakdownRow label={t('trips.complete.fareLabel')} value={formatPEN(earnings.fareCents)} />
          <BreakdownRow
            label={t('trips.complete.commissionLabel', { pct: commissionPercent(earnings.commissionRate) })}
            value={`- ${formatPEN(earnings.commissionCents)}`}
            valueColor="inkSubtle"
          />
          <BreakdownRow
            label={t('trips.complete.netLabel')}
            value={formatPEN(earnings.netCents)}
            valueColor="money"
          />
        </View>

        <View
          style={[
            styles.card,
            styles.rateCard,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.lg,
              padding: theme.spacing.lg,
              gap: theme.spacing.md,
            },
          ]}
        >
          <Text variant="bodyStrong" align="center">
            {rateTitle}
          </Text>
          <StarRating value={shownStars} onChange={setStars} readOnly={!canEdit} />

          {settled ? (
            <Text variant="footnote" color="success" align="center">
              {t('trips.complete.thanks')}
            </Text>
          ) : null}

          {/* Comentario opcional: aparece al elegir estrellas (divulgación progresiva, fiel al frame limpio). */}
          {canEdit && stars > 0 ? (
            <TextField
              label={t('trips.complete.commentLabel')}
              value={comment}
              onChangeText={setComment}
              placeholder={t('trips.complete.commentPlaceholder')}
              multiline
              maxLength={1000}
            />
          ) : null}

          {rateFailed ? (
            <Banner tone="danger" title={t('trips.complete.rateError')} />
          ) : null}
        </View>
      </ScrollView>
    </SafeScreen>
  );
};

interface BreakdownRowProps {
  label: string;
  value: string;
  valueColor?: 'ink' | 'inkSubtle' | 'money';
}

/** Fila etiqueta–monto del desglose. `money` = verde de acción profundo (`accentStrong`). */
function BreakdownRow({ label, value, valueColor = 'ink' }: BreakdownRowProps): React.JSX.Element {
  const theme = useTheme();
  const isMoney = valueColor === 'money';
  return (
    <View style={styles.row}>
      <Text variant="callout" color="inkMuted" style={styles.flex} numberOfLines={1}>
        {label}
      </Text>
      <Text
        variant="bodyStrong"
        color={isMoney ? 'ink' : valueColor}
        tabular
        numberOfLines={1}
        style={isMoney ? { color: theme.colors.accentStrong } : undefined}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 24, paddingTop: 8, paddingBottom: 24 },
  hero: { gap: 16, alignItems: 'center', paddingTop: 24, paddingBottom: 8 },
  badge: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    // Glow verde simétrico (halo, sin offset) — el "success glow" del frame.
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 12,
  },
  earn: { gap: 2, alignItems: 'center' },
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth },
  rateCard: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
});
