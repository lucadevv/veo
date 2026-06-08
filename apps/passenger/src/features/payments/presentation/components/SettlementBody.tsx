import type { PaymentView } from '@veo/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banner, Button, Card, Skeleton, StatusPill, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { formatPEN } from '../../../../shared/utils/format';
import { CheckoutInstructions, hasCheckout } from './CheckoutInstructions';
import { Animated, EnterView, SuccessCheck, usePressScale } from './motion';

/** Propinas rápidas post-viaje sugeridas (céntimos PEN), alineadas al handoff: [Sin, S/2, S/3, S/5]. */
const QUICK_TIPS_CENTS = [0, 200, 300, 500] as const;

/** Cadencia del poll del recibo mientras el cobro "procesa" (consumer Kafka puede demorar). */
const POLL_INTERVAL_MS = 2500;
/** Tope del poll: tras esto mostramos un error honesto con botón Reintentar. */
const POLL_TIMEOUT_MS = 30_000;

export interface SettlementBodyProps {
  /** Viaje COMPLETED a liquidar (`GET /payments/by-trip/:tripId`). */
  tripId: string;
  /**
   * El cobro quedó RESUELTO desde el punto de vista del pasajero (capturado, fallido, en deuda, o
   * efectivo ya confirmado por él) → el cierre puede avanzar al rating y cerrar normal.
   */
  onSettled: () => void;
  /**
   * El pasajero deja el cierre SIN resolver (efectivo PENDING que aún no confirmó): NO se cierra el
   * viaje, así el settlement re-aparece al volver (es plata). "Confirmar después".
   */
  onDeferred: () => void;
  /**
   * Cierre TERMINAL directo desde el recibo ya resuelto: calificar es OPCIONAL, así que cada estado
   * final ofrece una salida "Volver al inicio" que cierra el viaje sin pasar por el rating (mismo
   * camino que el cierre final). NO se ofrece en efectivo PENDING sin confirmar (es plata: solo
   * "Confirmar después", que NO cierra).
   */
  onFinish: () => void;
  /**
   * ¿Tiene sentido ofrecer la doble salida (calificar / volver al inicio)? Solo cuando el viaje tiene
   * conductor a calificar. Si no hay conductor, `onSettled` ya cierra directo y el botón "Calificar"
   * no aplica: no duplicamos la salida "Volver al inicio".
   */
  canFinish: boolean;
}

type UpperStatus = 'PENDING' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'DEBT' | string;

/** Normaliza el método a la clave i18n del kit (`payments.method.*`). */
function methodLabelKey(method: string): string {
  return `payments.method.${method.toUpperCase()}`;
}

/**
 * Cuerpo del CIERRE del viaje (recibo del cobro AUTOMÁTICO), in-sheet. REEMPLAZA a `PaymentBody`: el
 * cobro YA pasó al completar el viaje (consumer Kafka), así que acá NO se elige método ni se "paga" —
 * solo se REFLEJA el estado real del `Payment` y, si es efectivo, se confirma el lado del pasajero.
 *
 * Estados (derivados de `GET /payments/by-trip/:tripId`):
 *  - cargando → skeleton.
 *  - 404 transitorio (el consumer puede demorar) → "Procesando tu pago…" con poll suave (~2.5s, ~30s
 *    de tope) → si agota, error honesto con Reintentar.
 *  - PENDING + CASH → "Paga en efectivo" + banner del cash + "Confirmar efectivo" (POST cash/confirm).
 *    Si el pasajero confirma pero el conductor aún no (confirmación bilateral): "esperando al conductor".
 *  - PENDING + digital → "Procesando pago…" + poll.
 *  - CAPTURED → RECIBO canónico (check verde + desglose tarifa/propina/total) + propina post-viaje.
 *  - FAILED/DEBT → estado honesto (nunca data falsa), deja continuar al rating.
 */
export function SettlementBody({
  tripId,
  onSettled,
  onDeferred,
  onFinish,
  canFinish,
}: SettlementBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  // Doble salida del recibo ya resuelto: primario "Calificar viaje" + ghost "Volver al inicio" (cierre
  // directo). Calificar es OPCIONAL → no obligamos a pasar por el rating. Solo aplica si hay conductor
  // que calificar; sin conductor, `onSettled` ya cierra directo (no duplicamos botones). Elemento
  // (no componente anidado) para no romper la identidad de tipo entre renders.
  const resolvedActions = (
    <View style={{ gap: theme.spacing.sm }}>
      <Button label={t('settlement.rateTrip')} variant="primary" fullWidth onPress={onSettled} />
      {canFinish ? (
        <Button label={t('ratings.backHome')} variant="ghost" fullWidth onPress={onFinish} />
      ) : null}
    </View>
  );

  const getPaymentByTrip = useDependency(TOKENS.getPaymentByTripUseCase);
  const confirmCash = useDependency(TOKENS.confirmCashUseCase);
  const addTip = useDependency(TOKENS.addTipUseCase);

  // Ancla del poll: cuándo empezamos a esperar el cobro (para cortar a los ~30s).
  const startedAtRef = React.useRef<number>(Date.now());

  const paymentQuery = useQuery<PaymentView | null, Error>({
    queryKey: ['payment', tripId, 'by-trip'],
    queryFn: () => getPaymentByTrip.execute(tripId),
    // Poll suave MIENTRAS el cobro no existe (404→null) o sigue PENDING-digital, hasta el tope.
    refetchInterval: (query) => {
      const data = query.state.data;
      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed > POLL_TIMEOUT_MS) {
        return false;
      }
      if (data == null) {
        return POLL_INTERVAL_MS;
      }
      const status = data.status.toUpperCase();
      const isDigital = data.method.toUpperCase() !== 'CASH';
      if (status === 'PENDING' && isDigital) {
        return POLL_INTERVAL_MS;
      }
      return false;
    },
  });

  const confirmMutation = useMutation<PaymentView, Error, string>({
    mutationFn: (paymentId: string) => confirmCash.execute(paymentId),
    onSuccess: () => {
      // Re-sincroniza el recibo: si el conductor ya confirmó, el cobro pasa a CAPTURED.
      void paymentQuery.refetch();
    },
  });

  const tipMutation = useMutation<PaymentView, Error, number>({
    mutationFn: (tipCents: number) => addTip.execute(tripId, tipCents),
    onSuccess: () => {
      void paymentQuery.refetch();
    },
  });

  // Fuente de verdad: la confirmación de efectivo recién hecha pisa al fetch (trae el estado bilateral).
  const payment = confirmMutation.data ?? paymentQuery.data ?? null;

  // Reintenta el poll del recibo (reinicia la ventana de ~30s). Compartido por los estados de timeout
  // y por el checkout (tras pagar, el webhook pasa a CAPTURED y el refetch lo refleja).
  const retryPoll = React.useCallback(() => {
    startedAtRef.current = Date.now();
    void paymentQuery.refetch();
  }, [paymentQuery]);

  // ── Cargando (primer fetch) ──────────────────────────────────────────────────────────────────
  if (paymentQuery.isPending) {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <Text variant="callout" color="inkMuted" align="center">
          {t('settlement.loading')}
        </Text>
        <Skeleton variant="rect" height={150} />
      </View>
    );
  }

  const elapsed = Date.now() - startedAtRef.current;
  const timedOut = elapsed > POLL_TIMEOUT_MS;

  // ── El cobro aún no existe (404 transitorio) ─────────────────────────────────────────────────
  if (payment == null) {
    // Agotó el poll sin recibo: error honesto + reintentar (reinicia la ventana del poll).
    if (timedOut || paymentQuery.isError) {
      return (
        <View style={{ gap: theme.spacing.md }}>
          <Banner tone="warn" title={t('settlement.timeoutTitle')} description={t('settlement.timeoutBody')} />
          <Button
            label={t('actions.retry')}
            variant="primary"
            fullWidth
            loading={paymentQuery.isFetching}
            onPress={() => {
              startedAtRef.current = Date.now();
              void paymentQuery.refetch();
            }}
          />
          {/* Escape del 404-eterno: si el recibo nunca aparece, el pasajero NO queda atrapado en el sheet.
              "Cerrar" avanza el cierre como un settlement resuelto (onSettled → rating/cierre en CompletionBody),
              evitando que un consumer caído lo deje secuestrado en un viaje ya terminado. */}
          <Button label={t('actions.close')} variant="ghost" fullWidth onPress={onSettled} />
        </View>
      );
    }
    return <ProcessingBody title={t('settlement.processing')} hint={t('settlement.processingHint')} />;
  }

  const status: UpperStatus = payment.status.toUpperCase();
  const isCash = payment.method.toUpperCase() === 'CASH';
  const passengerConfirmedCash = confirmMutation.isSuccess;

  // ── PENDING + digital ────────────────────────────────────────────────────────────────────────
  if (status === 'PENDING' && !isCash) {
    // Pago digital con CHECKOUT (ProntoPaga): el usuario DEBE completarlo (deepLink / web / QR / CIP).
    // Tiene prioridad sobre el timeout del poll: mientras no venza, mostramos cómo pagar (no un error).
    // SIN checkout (sandbox actual) → todo como hoy: procesando + poll, CERO regresión.
    if (hasCheckout(payment)) {
      return <CheckoutBody payment={payment} onRetry={retryPoll} retrying={paymentQuery.isFetching} />;
    }
    if (timedOut) {
      return (
        <View style={{ gap: theme.spacing.md }}>
          <Banner tone="warn" title={t('settlement.timeoutTitle')} description={t('settlement.timeoutBody')} />
          <Button
            label={t('actions.retry')}
            variant="primary"
            fullWidth
            loading={paymentQuery.isFetching}
            onPress={retryPoll}
          />
        </View>
      );
    }
    return <ProcessingBody title={t('settlement.processingDigital')} hint={t('settlement.processingHint')} />;
  }

  // ── PENDING + CASH ───────────────────────────────────────────────────────────────────────────
  if (status === 'PENDING' && isCash) {
    // El pasajero ya confirmó su lado pero el cobro sigue PENDING → falta el conductor (bilateral).
    if (passengerConfirmedCash) {
      return (
        <View style={{ gap: theme.spacing.md }}>
          <Banner
            tone="info"
            title={t('settlement.cashAwaitingDriverTitle')}
            description={t('settlement.cashAwaitingDriverBody')}
          />
          <ReceiptCard payment={payment} cash />
          {/* El pasajero ya hizo su parte (su lado del efectivo está confirmado): el cobro se cierra
              cuando el conductor confirma. Doble salida: calificar (opcional) o volver al inicio. */}
          {resolvedActions}
        </View>
      );
    }

    return (
      <View style={{ gap: theme.spacing.md }}>
        <Text variant="title3">{t('settlement.cashTitle')}</Text>
        <Text variant="callout" color="inkMuted">
          {t('settlement.cashBody', { amount: formatPEN(payment.amountCents) })}
        </Text>
        <ReceiptCard payment={payment} cash />
        <Banner tone="info" title={t('settlement.cashBanner')} />
        {confirmMutation.isError ? <Banner tone="danger" title={t('payments.payError')} /> : null}
        <Button
          label={confirmMutation.isPending ? t('settlement.confirmingCash') : t('settlement.confirmCash')}
          variant="accent"
          fullWidth
          loading={confirmMutation.isPending}
          onPress={() => confirmMutation.mutate(payment.id)}
        />
        {/* Escape sin cerrar: el settlement re-aparece al volver (es plata, no la perdemos). */}
        <Button label={t('settlement.confirmLater')} variant="ghost" fullWidth onPress={onDeferred} />
      </View>
    );
  }

  // ── FAILED / DEBT → estado honesto, nunca data falsa; deja continuar al rating ───────────────
  if (status === 'FAILED' || status === 'DEBT') {
    const isDebt = status === 'DEBT';
    return (
      <View style={{ gap: theme.spacing.md }}>
        <Banner
          tone={isDebt ? 'warn' : 'danger'}
          title={t(isDebt ? 'settlement.debtTitle' : 'settlement.failedTitle')}
          description={t(isDebt ? 'settlement.debtBody' : 'settlement.failedBody')}
        />
        <ReceiptCard payment={payment} />
        {resolvedActions}
      </View>
    );
  }

  // ── REFUNDED → reembolso honesto: SIN check verde, SIN "pagado", SIN propina ─────────────────
  // El cobro se revirtió (devolución): no celebramos un pago que ya no existe. Mostramos un banner
  // NEUTRAL + el desglose (sin el check de éxito) y dejamos continuar al rating/cierre. Si ofreciéramos
  // chips de propina sobre un viaje reembolsado, le pediríamos plata por algo que le devolvimos: no va.
  if (status === 'REFUNDED') {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <Banner
          tone="info"
          title={t('settlement.refundedTitle')}
          description={t('settlement.refundedBody', { amount: formatPEN(payment.amountCents) })}
        />
        <ReceiptCard payment={payment} />
        {resolvedActions}
      </View>
    );
  }

  // ── CAPTURED (o efectivo ya capturado por ambos) → RECIBO canónico ───────────────────────────
  return (
    <View style={{ gap: theme.spacing.md }}>
      <SuccessCheck />
      <EnterView delay={140}>
        <Banner
          tone="success"
          title={t(isCash ? 'payments.cashConfirmed' : 'settlement.paidTitle')}
          description={t('settlement.paidBody', {
            amount: formatPEN(payment.amountCents),
            method: t(methodLabelKey(payment.method)),
          })}
        />
      </EnterView>
      <EnterView delay={200}>
        <ReceiptCard payment={payment} />
      </EnterView>

      {/* Propina post-viaje: solo si aún no dejó (tipCents === 0). Chips [Sin, S/2, S/3, S/5]. */}
      {payment.tipCents === 0 ? (
        <EnterView delay={260}>
          <View style={{ gap: theme.spacing.sm }}>
            {/* Coherencia propina-efectivo: en un viaje CASH la tarifa va en mano, pero estos chips cobran
                la propina DIGITAL (Yape/tarjeta). El prompt lo dice honesto (no miente "100% efectivo");
                el LUGAR de la propina sigue siendo post-pago, sin un flujo nuevo de propina-efectivo. */}
            <Text variant="footnote" color="inkMuted">
              {t(isCash ? 'settlement.tipPromptCash' : 'settlement.tipPrompt')}
            </Text>
            {tipMutation.isError ? <Banner tone="danger" title={t('tips.error')} /> : null}
            <View style={[styles.chips, { gap: theme.spacing.sm }]}>
              {QUICK_TIPS_CENTS.map((cents) => (
                <TipChip
                  key={cents}
                  label={cents === 0 ? t('settlement.tipNone') : formatPEN(cents)}
                  tabular={cents !== 0}
                  loading={tipMutation.isPending && tipMutation.variables === cents}
                  // Anti doble-propina: una vez que la propina se envió OK, los chips quedan deshabilitados
                  // hasta que el refetch traiga tipCents>0 y oculte el bloque. Sin esto, entre el onSuccess y
                  // el re-render del refetch el pasajero podía tocar otro chip y mandar una segunda propina.
                  disabled={tipMutation.isPending || tipMutation.isSuccess}
                  // "Sin propina" no llama al backend (tipCents mínimo es 1): solo avanza.
                  onPress={() => (cents === 0 ? undefined : tipMutation.mutate(cents))}
                />
              ))}
            </View>
          </View>
        </EnterView>
      ) : null}

      {resolvedActions}
    </View>
  );
}

/** Tarjeta de desglose canónica: Tarifa acordada / Propina (si >0) / divisor / Total (bold). */
function ReceiptCard({ payment, cash = false }: { payment: PaymentView; cash?: boolean }): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Card variant="outlined" padding="lg">
      <View style={styles.row}>
        <Text variant="callout" color="inkMuted">
          {t('payments.breakdownFare')}
        </Text>
        <Text variant="callout" tabular>
          {formatPEN(payment.grossCents)}
        </Text>
      </View>
      {payment.tipCents > 0 ? (
        <View style={styles.row}>
          <Text variant="callout" color="inkMuted">
            {t('payments.breakdownTip')}
          </Text>
          <Text variant="callout" tabular>
            {formatPEN(payment.tipCents)}
          </Text>
        </View>
      ) : null}
      <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
      <View style={styles.row}>
        <Text variant="bodyStrong">{t('payments.breakdownTotal')}</Text>
        <Text variant="title3" tabular>
          {formatPEN(payment.amountCents)}
        </Text>
      </View>
      <View style={[styles.row, { marginTop: theme.spacing.xs }]}>
        <Text variant="footnote" color="inkMuted">
          {t('payments.status')}
        </Text>
        <StatusPill
          label={t(`payments.method.${payment.method.toUpperCase()}`)}
          tone={cash ? 'neutral' : 'accent'}
          dot
        />
      </View>
    </Card>
  );
}

/** Estado "procesando" (cobro automático en vuelo): spinner tipográfico sobrio + hint. */
function ProcessingBody({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.md, alignItems: 'center', paddingVertical: theme.spacing.md }}>
      <Skeleton variant="circle" height={56} />
      <Text variant="title3" align="center">
        {title}
      </Text>
      <Text variant="footnote" color="inkMuted" align="center">
        {hint}
      </Text>
    </View>
  );
}

/**
 * Rama "Completa tu pago" del RECIBO: pago digital PENDING con checkout (ProntoPaga). Mantiene el
 * desglose del recibo (`ReceiptCard`) como encabezado y delega los MEDIOS (deepLink/web/QR/CIP) al
 * componente COMPARTIDO `CheckoutInstructions` (mismo lenguaje que el sheet de deuda, sin duplicar).
 */
function CheckoutBody({
  payment,
  onRetry,
  retrying,
}: {
  payment: PaymentView;
  onRetry: () => void;
  retrying: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <CheckoutInstructions
      payment={payment}
      onRetry={onRetry}
      retrying={retrying}
      header={
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="title3">{t('settlement.checkout.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('settlement.checkout.body')}
          </Text>
          <ReceiptCard payment={payment} />
        </View>
      }
    />
  );
}

interface TipChipProps {
  label: string;
  onPress: () => void;
  tabular?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

/** Chip de propina post-viaje: feedback de press (scale) + hit-target ≥44. Respeta reduce-motion. */
function TipChip({ label, onPress, tabular = false, loading = false, disabled = false }: TipChipProps): React.JSX.Element {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      hitSlop={8}
    >
      <Animated.View
        style={[
          styles.chip,
          animatedStyle,
          {
            opacity: disabled && !loading ? 0.5 : 1,
            borderRadius: theme.radii.pill,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            borderColor: theme.colors.border,
            borderWidth: 1,
            backgroundColor: theme.colors.surface,
          },
        ]}
      >
        <Text variant="bodyStrong" color={loading ? 'inkMuted' : 'ink'} tabular={tabular}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  divider: { height: 1, marginVertical: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
});
