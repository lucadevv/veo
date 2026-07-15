import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, SuccessCheck, Text, TextField, useTheme } from '@veo/ui-kit';
import { ApiError, mobilePaymentMethod } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { formatPEN, formatPersonName } from '../../../../shared/presentation/format';
import type { DriverProfile } from '../../../profile/domain';
import { PROFILE_QUERY_KEY } from '../../../profile/domain';
import { StarRating } from '../../../ratings/presentation';
import { useCountUp } from '../../../earnings/presentation/components/motion';
import { useMyTripRating, useRatePassenger } from '../hooks/usePassengerRating';
import { useCommissionRate, useConfirmCash } from '../hooks/useTrips';
import { commissionPercent, commissionRateFromBps, computeTripEarnings } from '../../domain';
import { Appear } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripComplete'>;

/**
 * Verde del CHECK de "viaje completado" — jade `#17C08A`, UNIFICADO con el check del pasajero
 * (`SuccessCheck` del cierre, `success` del tema passenger) por pedido del dueño: el momento celebratorio
 * de éxito se ve IGUAL en ambas apps. Excepción DOCUMENTADA al token `success` del driver light (#00C853,
 * board-exact): acá prima la consistencia cross-app del check sobre la fidelidad al board del conductor.
 */
const SUCCESS_CHECK_GREEN = '#17C08A';


/**
 * Cierre del viaje del conductor (frame C/TripComplete): resumen de ganancia (tarifa − comisión = neto)
 * + calificación al pasajero (1-5 + comentario opcional). "Listo" envía la calificación (si eligió
 * estrellas) y vuelve al dashboard; sin estrellas, el rating es opcional y "Listo" cierra igual.
 *
 * El monto sale del `fareCents` del viaje (`driverTripView`) descompuesto por `computeTripEarnings`
 * (mismo modelo bruto − comisión de la pantalla de Ganancias) porque el agregado del período aún no se
 * recompuso al cerrar. La TASA es la VIGENTE del panel admin (`useCommissionRate`, vía driver-bff) —
 * nunca un hardcode; sin red degrada al fallback offline (20 %, el default del backend). El nombre del
 * conductor se LEE de la caché del perfil (sin disparar un fetch); si
 * no está, el saludo degrada a genérico. El nombre del pasajero no viaja en el contrato del viaje
 * (regla #5, PII) → la pregunta degrada a "¿Cómo estuvo tu pasajero?".
 */
export const TripCompleteScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { tripId, passengerId, fareCents, paymentMethod, passengerName } = route.params;

  // EFECTIVO (decisión del dueño 2026-07-14): en un viaje CASH, el conductor confirma el cobro en mano
  // ACÁ, en el resumen (POST-completado) — su confirmación ÚNICA captura el pago directo. En digital no
  // hay nada que confirmar (ya se cobró al riel). La card solo aplica a efectivo.
  const isCash = paymentMethod === mobilePaymentMethod.enum.CASH;
  const confirmCash = useConfirmCash(tripId);
  // Tras confirmar OK, `variables` retiene el último `collected` enviado: distingue "Cobro registrado"
  // (true) de "Reporte enviado" (false) sin estado extra.
  const cashSettled = confirmCash.isSuccess;
  const cashCollected = confirmCash.variables ?? null;

  // Tasa VIGENTE del panel (query cacheada); `undefined` (cargando/offline) pliega al fallback 20 %.
  const commissionRate = useCommissionRate();
  const earnings = computeTripEarnings(
    fareCents,
    commissionRateFromBps(commissionRate.data?.onDemandRateBps),
  );
  // Count-up del NETO ganado (el payoff de plata): sube de 0 al monto al montar, como en Ganancias.
  const animatedNet = useCountUp(earnings.netCents);

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
          // EFECTIVO: no se puede salir con "Listo" hasta RESOLVER el cobro (confirmar "Sí, recibí" o
          // "No cobré") — el efectivo es plata que el conductor DEBE registrar antes de cerrar. En digital
          // (o una vez resuelto el cash) el botón queda habilitado normal.
          disabled={isCash && !cashSettled}
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
          {/* Sello de éxito CANÓNICO (@veo/ui-kit): círculo jade + check negro + pop. Antes era un badge
              translúcido local con IconCheck verde — ahora idéntico al del pasajero (simetría). */}
          <SuccessCheck size={84} />
          <Text variant="titleEditorial" align="center">
            {t('trips.complete.title')}
          </Text>
          <Text variant="footnote" color="inkSubtle" align="center">
            {subtitle}
          </Text>
        </Appear>

        {/* EFECTIVO · confirmación de cobro en mano (POST-completado). Debajo del check de éxito, con la
            estética de la pantalla (Card + Button del ui-kit). Al confirmar, la card se reemplaza por una
            nota sutil. Solo en viajes CASH. */}
        {isCash ? (
          <View
            style={[
              styles.card,
              styles.cashCard,
              {
                backgroundColor: theme.colors.surface,
                borderColor: cashSettled ? theme.colors.border : SUCCESS_CHECK_GREEN,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.lg,
                gap: theme.spacing.md,
              },
            ]}
          >
            {cashSettled ? (
              <Text variant="bodyStrong" align="center" style={{ color: SUCCESS_CHECK_GREEN }}>
                {cashCollected
                  ? t('trips.complete.cashRegistered')
                  : t('trips.complete.cashReported')}
              </Text>
            ) : (
              <>
                <Text variant="bodyStrong" align="center">
                  {t('trips.complete.cashPrompt', { amount: formatPEN(fareCents) })}
                </Text>
                <View style={styles.cashActions}>
                  <Button
                    label={t('trips.complete.cashReceived')}
                    variant="safe"
                    fullWidth
                    loading={confirmCash.isPending && confirmCash.variables === true}
                    disabled={confirmCash.isPending}
                    onPress={() => confirmCash.mutate(true)}
                  />
                  <Button
                    label={t('trips.complete.cashNotCollected')}
                    variant="ghost"
                    fullWidth
                    loading={confirmCash.isPending && confirmCash.variables === false}
                    disabled={confirmCash.isPending}
                    onPress={() => confirmCash.mutate(false)}
                  />
                </View>
                {confirmCash.isError ? (
                  <Banner tone="danger" title={t('trips.complete.cashError')} />
                ) : null}
              </>
            )}
          </View>
        ) : null}

        <View style={styles.earn}>
          <Text variant="label" color="inkSubtle">
            {t('trips.complete.earningsLabel')}
          </Text>
          <Text variant="display" tabular style={{ color: theme.colors.accentStrong }}>
            {formatPEN(animatedNet)}
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
  earn: { gap: 2, alignItems: 'center' },
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth },
  // La card de cobro lleva su propio borde (jade sin confirmar → gris tras confirmar): borde algo más
  // marcado que el hairline del resto para destacar la acción pendiente.
  cashCard: { borderWidth: 1 },
  cashActions: { gap: 10 },
  rateCard: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
});
