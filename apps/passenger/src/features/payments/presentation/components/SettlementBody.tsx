import type {PaymentView} from '@veo/api-client';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  Skeleton,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatPEN} from '../../../../shared/utils/format';
import {
  assertNever,
  interpretPaymentOutcome,
  isCashPayment,
} from '../../domain/paymentOutcome';
import {CheckoutInstructions} from './CheckoutInstructions';
import {Animated, EnterView, SuccessCheck, usePressScale} from './motion';

/** Propinas rápidas post-viaje (céntimos PEN), per design/veo.pen I7ahU: [Sin, S/2, S/5] + "Otro". */
const QUICK_TIPS_CENTS = [0, 200, 500] as const;
/** Tope de cordura del monto libre de propina (céntimos): evita typos de un cero de más. */
const MAX_CUSTOM_TIP_CENTS = 50_000;

/** Cadencia del poll del recibo mientras el cobro "procesa" (consumer Kafka puede demorar). */
const POLL_INTERVAL_MS = 2500;
/**
 * Ventana del poll RÁPIDO: tras esto mostramos el aviso honesto ("está tardando") con Reintentar, pero
 * el poll NO muere — degrada a la cadencia lenta de abajo.
 */
const POLL_TIMEOUT_MS = 30_000;
/**
 * Cadencia LENTA indefinida tras agotar la ventana rápida. La pantalla PROMETE "se actualiza sola"
 * (`settlement.processingHint`): cortar el poll a los 30 s la dejaba clavada si el webhook/consumer
 * resolvía después (reproducido en el sim) — el pasajero tenía que relanzar la app. Es UNA row por
 * tripId cada 30 s solo mientras el recibo esté montado: barato y honesto.
 */
const SLOW_POLL_INTERVAL_MS = 30_000;

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
   * Cierre TERMINAL directo (closeTrip → passengerClosedAt): calificar es OPCIONAL, así que cada estado
   * final ofrece una salida "Volver al inicio" que cierra el viaje sin pasar por el rating (mismo
   * camino que el cierre final). También es la salida "Pagar después" del checkout pendiente: el
   * Payment PENDING sigue vivo server-side y la franja PENDING_ACTION del home toma el relevo. NO se
   * ofrece en efectivo PENDING sin confirmar (es plata: solo "Confirmar después", que NO cierra).
   */
  onFinish: () => void;
  /**
   * ¿Tiene sentido ofrecer la doble salida (calificar / volver al inicio)? Solo cuando el viaje tiene
   * conductor a calificar. Si no hay conductor, `onSettled` ya cierra directo y el botón "Calificar"
   * no aplica: no duplicamos la salida "Volver al inicio".
   */
  canFinish: boolean;
}

// Qué resultado tiene el cobro lo responde el DOMINIO (`interpretPaymentOutcome` → `PaymentOutcome`):
// esta vista hace switch EXHAUSTIVO sobre el outcome y solo elige UI. La lección de PARTIALLY_REFUNDED
// (que caía al recibo "Pagado" por un escape `| string`) ahora es un gate de compile-time compartido
// con `DebtSheet`, no un tipo local de esta vista.

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
 *  - 404 transitorio (el consumer puede demorar) → "Procesando tu pago…" con poll suave (~2.5s). A los
 *    ~30s: aviso honesto con Reintentar, pero el poll DEGRADA a cadencia lenta (no muere): si el cobro
 *    resuelve tarde, la pantalla igual se actualiza sola (lo que promete el copy).
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
  const {t} = useTranslation();

  // Doble salida del recibo ya resuelto: primario "Calificar viaje" + ghost "Volver al inicio" (cierre
  // directo). Calificar es OPCIONAL → no obligamos a pasar por el rating. Solo aplica si hay conductor
  // que calificar; sin conductor, `onSettled` ya cierra directo (no duplicamos botones). Elemento
  // (no componente anidado) para no romper la identidad de tipo entre renders.
  const resolvedActions = (
    <View style={{gap: theme.spacing.sm}}>
      <Button
        label={t('settlement.rateTrip')}
        variant="primary"
        fullWidth
        onPress={onSettled}
      />
      {canFinish ? (
        <Button
          label={t('ratings.backHome')}
          variant="ghost"
          fullWidth
          onPress={onFinish}
        />
      ) : null}
    </View>
  );

  const getPaymentByTrip = useDependency(TOKENS.getPaymentByTripUseCase);
  const addTip = useDependency(TOKENS.addTipUseCase);

  // Ancla del poll: cuándo empezamos a esperar el cobro (para cortar a los ~30s).
  const startedAtRef = React.useRef<number>(Date.now());

  const paymentQuery = useQuery<PaymentView | null, Error>({
    queryKey: ['payment', tripId, 'by-trip'],
    queryFn: () => getPaymentByTrip.execute(tripId),
    // Poll MIENTRAS el cobro no existe (404→null) o sigue PENDING-digital: rápido dentro de la ventana,
    // LENTO indefinido después (mientras el recibo esté montado). Resuelto el outcome → se apaga.
    refetchInterval: query => {
      const data = query.state.data;
      // Sigue pendiente si aún no hay recibo o el outcome puede moverse (webhook/consumer tardío).
      const stillPending =
        data == null ||
        (() => {
          const outcome = interpretPaymentOutcome(data);
          return (
            outcome.kind === 'checkoutPending' ||
            outcome.kind === 'processing' ||
            // EFECTIVO: transitorio mientras el consumer captura tras la confirmación del conductor
            // (el pasajero ya no confirma) → poll hasta el recibo CAPTURED.
            outcome.kind === 'cashPending'
          );
        })();
      if (!stillPending) {
        return false;
      }
      const elapsed = Date.now() - startedAtRef.current;
      return elapsed > POLL_TIMEOUT_MS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    },
  });


  const tipMutation = useMutation<PaymentView, Error, number>({
    mutationFn: (tipCents: number) => addTip.execute(tripId, tipCents),
    onSuccess: () => {
      void paymentQuery.refetch();
    },
  });

  // Chip "Otro" (design/veo.pen I7ahU): monto libre de propina en un sheet chico. El texto vive acá
  // (no en el sheet) para poder validar/parsear antes de mutar; se resetea al cerrar.
  const [customTipOpen, setCustomTipOpen] = React.useState(false);
  const [customTipText, setCustomTipText] = React.useState('');
  // Soles con decimales opcionales ("5" / "5.50") → céntimos. NaN/fuera de rango → null (botón gris).
  const customTipCents = React.useMemo(() => {
    const parsed = Number(customTipText.replace(',', '.'));
    if (!Number.isFinite(parsed)) return null;
    const cents = Math.round(parsed * 100);
    return cents > 0 && cents <= MAX_CUSTOM_TIP_CENTS ? cents : null;
  }, [customTipText]);
  const closeCustomTip = (): void => {
    setCustomTipOpen(false);
    setCustomTipText('');
  };

  // Fuente de verdad: la confirmación de efectivo recién hecha pisa al fetch (trae el estado bilateral).
  const payment = paymentQuery.data ?? null;

  // Reintenta el poll del recibo (reinicia la ventana de ~30s). Compartido por los estados de timeout
  // y por el checkout (tras pagar, el webhook pasa a CAPTURED y el refetch lo refleja).
  const retryPoll = React.useCallback(() => {
    startedAtRef.current = Date.now();
    void paymentQuery.refetch();
  }, [paymentQuery]);

  // ── Cargando (primer fetch) ──────────────────────────────────────────────────────────────────
  if (paymentQuery.isPending) {
    return (
      <View style={{gap: theme.spacing.md}}>
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
        <View style={{gap: theme.spacing.md}}>
          <Banner
            tone="warn"
            title={t('settlement.timeoutTitle')}
            description={t('settlement.timeoutBody')}
          />
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
          <Button
            label={t('actions.close')}
            variant="ghost"
            fullWidth
            onPress={onSettled}
          />
        </View>
      );
    }
    return (
      <ProcessingBody
        title={t('settlement.processing')}
        hint={t('settlement.processingHint')}
      />
    );
  }

  // La interpretación del cobro vive en el DOMINIO (`interpretPaymentOutcome` → `PaymentOutcome`):
  // cada rama de abajo elige UI sobre `outcome.kind` y RETORNA; el guard con `assertNever` antes del
  // recibo final sella la exhaustividad en compile-time (un `PaymentOutcome.kind` nuevo obliga acá).
  const outcome = interpretPaymentOutcome(payment);
  const isCash = isCashPayment(payment);

  // ── PENDING digital con CHECKOUT (ProntoPaga): el usuario DEBE completarlo (deepLink/web/QR/CIP).
  // Tiene prioridad sobre el timeout del poll: mientras no venza, mostramos cómo pagar (no un error).
  if (outcome.kind === 'checkoutPending') {
    return (
      <View style={{gap: theme.spacing.md}}>
        <CheckoutBody
          payment={payment}
          onRetry={retryPoll}
          retrying={paymentQuery.isFetching}
        />
        {/* Salida "Pagar después": nadie queda preso del checkout — un CIP (PagoEfectivo) se paga en
            banco/agente HORAS o DÍAS después de terminado el viaje. Camino VERIFICADO: tiene que ser
            `onFinish` (cierra el post-viaje: closeTrip → passengerClosedAt → el trip sale de
            /trips/pending-settlement). Con `onDeferred` NO habría salida real: sin passengerClosedAt,
            useHydrateActiveTrip re-adopta el settlement en cada foco del home y re-abre este mismo
            sheet. El Payment PENDING con checkout vivo sigue en el server: GET /payments/debts lo
            expone como PENDING_ACTION (NO bloquea pedir viajes) y la franja del home "Tienes un pago
            por completar → Continuar" reabre ESTE mismo checkout (DebtSheet en modo pending-action). */}
        <Button
          label={t('settlement.checkout.payLater')}
          variant="ghost"
          fullWidth
          onPress={onFinish}
        />
      </View>
    );
  }

  // ── PENDING digital SIN checkout (sandbox actual): procesando + poll, CERO regresión ────────────
  if (outcome.kind === 'processing') {
    if (timedOut) {
      return (
        <View style={{gap: theme.spacing.md}}>
          <Banner
            tone="warn"
            title={t('settlement.timeoutTitle')}
            description={t('settlement.timeoutBody')}
          />
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
    return (
      <ProcessingBody
        title={t('settlement.processingDigital')}
        hint={t('settlement.processingHint')}
      />
    );
  }

  // ── PENDING + CASH ───────────────────────────────────────────────────────────────────────────
  // El pasajero YA NO confirma el efectivo (decisión del dueño 2026-07-14): el CONDUCTOR lo captura al
  // confirmar que cobró (tiene la plata en mano). Esta rama es TRANSITORIA (mientras el consumer captura
  // tras la confirmación del conductor) → nota sobria + poll hasta el recibo CAPTURED ("Pago en efectivo
  // confirmado" con el check verde). SIN botón de confirmar ni doble paso bilateral.
  if (outcome.kind === 'cashPending') {
    return (
      <ProcessingBody
        title={t('settlement.cashProcessing')}
        hint={t('settlement.processingHint')}
      />
    );
  }

  // ── FAILED / DEBT → estado honesto, nunca data falsa; deja continuar al rating ───────────────
  if (outcome.kind === 'failed' || outcome.kind === 'debt') {
    const isDebt = outcome.kind === 'debt';
    return (
      <View style={{gap: theme.spacing.md}}>
        <Banner
          tone={isDebt ? 'warn' : 'danger'}
          title={t(isDebt ? 'settlement.debtTitle' : 'settlement.failedTitle')}
          description={t(
            isDebt ? 'settlement.debtBody' : 'settlement.failedBody',
          )}
        />
        <ReceiptCard payment={payment} />
        {resolvedActions}
      </View>
    );
  }

  // ── REFUNDED / PARTIALLY_REFUNDED → reembolso honesto: SIN check verde, SIN "pagado", SIN propina ─
  // El cobro se revirtió (total o parcial): no celebramos un pago como pleno cuando se devolvió plata.
  // Banner NEUTRAL + desglose (sin el check de éxito) y dejamos continuar al rating/cierre. Nada de
  // chips de propina: pedir plata sobre un viaje que reembolsamos (aunque sea en parte) no va.
  // PARTIALLY_REFUNDED no expone el monto devuelto en el contrato → texto honesto sin inventar cifra.
  if (outcome.kind === 'refunded') {
    const isPartial = outcome.partial;
    return (
      <View style={{gap: theme.spacing.md}}>
        <Banner
          tone="info"
          title={t(
            isPartial
              ? 'settlement.partialRefundTitle'
              : 'settlement.refundedTitle',
          )}
          description={
            isPartial
              ? t('settlement.partialRefundBody')
              : t('settlement.refundedBody', {
                  amount: formatPEN(payment.amountCents),
                })
          }
        />
        <ReceiptCard payment={payment} />
        {resolvedActions}
      </View>
    );
  }

  // Resultado del COBRO de la propina, clasificado por el DOMINIO (mismo criterio que `TipCard`): un
  // tip PENDING con checkout (Yape one-shot deepLink/QR — el caso común sin afiliación on-file — o CIP)
  // NO está "enviado": si se descarta el PaymentView, el checkout nunca se muestra, el tip muere FAILED
  // y el pasajero cree que la dejó mientras el conductor no la cobra.
  const tipPayment = tipMutation.data ?? null;
  const tipOutcome = tipPayment ? interpretPaymentOutcome(tipPayment) : null;
  const tipNeedsCheckout = tipOutcome?.kind === 'checkoutPending';
  const tipFailed = tipOutcome?.kind === 'failed' || tipOutcome?.kind === 'debt';
  // Candado anti doble-propina (ver el comentario de los chips). Si el cobro devuelto FALLÓ terminal,
  // se DESTRABA: el pasajero puede elegir de nuevo (la idempotencia por dedupKey hace que repetir el
  // MISMO monto devuelva el FAILED sin cobrar; un monto distinto se cobra normal — igual que TipCard).
  const tipLocked =
    tipMutation.isPending || (tipMutation.isSuccess && !tipFailed);

  // ── CAPTURED (o efectivo ya capturado por ambos) → RECIBO canónico ───────────────────────────
  // SELLO de exhaustividad: a esta altura todas las ramas anteriores RETORNARON, así que el único
  // kind posible es 'settled'. Si `PaymentOutcome` suma un kind nuevo, este guard deja de narrowear
  // a never y `assertNever` revienta en COMPILE-TIME (no más fallthrough silencioso al recibo
  // "Pagado" — la lección de PARTIALLY_REFUNDED).
  if (outcome.kind !== 'settled') {
    return assertNever(outcome);
  }
  return (
    <View style={{gap: theme.spacing.md}}>
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

      {/* El COBRO de la propina exige completar un checkout (Yape one-shot / QR / CIP): lo mostramos
          con el componente CANÓNICO (el mismo del recibo/deuda/TipCard) en vez de descartarlo — antes
          el PaymentView se tiraba y el tip quedaba PENDING hasta morir FAILED en silencio. `onRetry`
          re-corre el cobro, IDEMPOTENTE por dedupKey: al confirmar, el webhook devuelve el mismo cobro
          ya CAPTURED y el refetch del recibo trae tipCents > 0 (el "gracias" actual del desglose). */}
      {tipNeedsCheckout && tipPayment ? (
        <EnterView delay={260}>
          <Card variant="outlined" padding="lg">
            <CheckoutInstructions
              payment={tipPayment}
              retrying={tipMutation.isPending}
              onRetry={() => tipMutation.mutate(tipPayment.tipCents)}
              header={
                <>
                  <Text variant="title3">{t('tips.checkoutTitle')}</Text>
                  <Text variant="callout" color="inkMuted">
                    {t('tips.checkoutBody', {
                      amount: formatPEN(tipPayment.tipCents),
                    })}
                  </Text>
                </>
              }
            />
          </Card>
        </EnterView>
      ) : /* Propina post-viaje: solo si aún no dejó (tipCents === 0). Chips [Sin, S/2, S/5] + "Otro". */
      payment.tipCents === 0 ? (
        <EnterView delay={260}>
          <View style={{gap: theme.spacing.sm}}>
            {/* Coherencia propina-efectivo: en un viaje CASH la tarifa va en mano, pero estos chips cobran
                la propina DIGITAL (Yape/tarjeta). El prompt lo dice honesto (no miente "100% efectivo");
                el LUGAR de la propina sigue siendo post-pago, sin un flujo nuevo de propina-efectivo. */}
            <Text variant="footnote" color="inkMuted">
              {t(isCash ? 'settlement.tipPromptCash' : 'settlement.tipPrompt')}
            </Text>
            {tipMutation.isError ? (
              <Banner tone="danger" title={t('tips.error')} />
            ) : null}
            {/* El cobro devuelto FALLÓ terminal (declive/expiró): honesto — sin esto el pasajero creía
                que la propina salió. Los chips quedan destrabados para elegir de nuevo (ver tipLocked). */}
            {tipFailed ? (
              <Banner
                tone="danger"
                title={t('tips.failedTitle')}
                description={t('tips.failedBody')}
              />
            ) : null}
            {/* On-file (Yape vinculado): cobrándose server-initiated, se confirma por webhook. */}
            {tipOutcome?.kind === 'processing' ? (
              <Banner
                tone="info"
                title={t('tips.processingTitle')}
                description={t('tips.processingBody')}
              />
            ) : null}
            <View style={[styles.chips, {gap: theme.spacing.sm}]}>
              {QUICK_TIPS_CENTS.map(cents => (
                <TipChip
                  key={cents}
                  label={
                    cents === 0 ? t('settlement.tipNone') : formatPEN(cents)
                  }
                  tabular={cents !== 0}
                  loading={
                    tipMutation.isPending && tipMutation.variables === cents
                  }
                  // Anti doble-propina: una vez que la propina se envió OK, los chips quedan deshabilitados
                  // hasta que el refetch traiga tipCents>0 y oculte el bloque. Sin esto, entre el onSuccess y
                  // el re-render del refetch el pasajero podía tocar otro chip y mandar una segunda propina.
                  // Se destraba SOLO si el cobro devuelto falló terminal (tipFailed): elegir de nuevo.
                  disabled={tipLocked}
                  // "Sin propina" no llama al backend (tipCents mínimo es 1): solo avanza.
                  onPress={() =>
                    cents === 0 ? undefined : tipMutation.mutate(cents)
                  }
                />
              ))}
              {/* "Otro" (pen I7ahU): monto libre en un sheet chico, misma mutación anti-doble. */}
              <TipChip
                label={t('settlement.tipOther')}
                disabled={tipLocked}
                onPress={() => setCustomTipOpen(true)}
              />
            </View>
          </View>
        </EnterView>
      ) : null}

      {resolvedActions}

      {/* Sheet del monto libre de propina (pen I7ahU "Otro"): soles con decimales, tope de cordura,
          misma mutación (y el mismo candado anti doble-propina) que los chips rápidos. */}
      <BottomSheet
        visible={customTipOpen}
        onClose={closeCustomTip}
        title={t('settlement.tipCustomTitle')}
        footer={
          <Button
            label={
              customTipCents != null
                ? t('settlement.tipCustomConfirm', {
                    amount: formatPEN(customTipCents),
                  })
                : t('settlement.tipCustomConfirmEmpty')
            }
            variant="primary"
            fullWidth
            disabled={customTipCents == null || tipMutation.isPending}
            loading={tipMutation.isPending}
            onPress={() => {
              if (customTipCents != null) {
                tipMutation.mutate(customTipCents);
                closeCustomTip();
              }
            }}
          />
        }>
        <TextField
          label={t('settlement.tipCustomLabel')}
          value={customTipText}
          onChangeText={setCustomTipText}
          keyboardType="decimal-pad"
          autoFocus
        />
      </BottomSheet>
    </View>
  );
}

/** Tarjeta de desglose canónica: Tarifa acordada / Propina (si >0) / divisor / Total (bold). */
function ReceiptCard({
  payment,
  cash = false,
}: {
  payment: PaymentView;
  cash?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  return (
    <Card variant="outlined" padding="lg">
      {/* Desglose per design/veo.pen I7ahU: cuando el cobro trae comisión VISIBLE al usuario
          (`feeCents`, semántica del payment-service), se abre en "Tarifa base + Cargo por servicio
          VEO" (base = gross − fee; la suma cierra con el Total). Sin fee → una sola línea, como antes. */}
      {payment.feeCents > 0 ? (
        <>
          <View style={styles.row}>
            <Text variant="callout" color="inkMuted">
              {t('payments.breakdownBaseFare')}
            </Text>
            <Text variant="callout" tabular>
              {formatPEN(payment.grossCents - payment.feeCents)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text variant="callout" color="inkMuted">
              {t('payments.breakdownServiceFee')}
            </Text>
            <Text variant="callout" tabular>
              {formatPEN(payment.feeCents)}
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.row}>
          <Text variant="callout" color="inkMuted">
            {t('payments.breakdownFare')}
          </Text>
          <Text variant="callout" tabular>
            {formatPEN(payment.grossCents)}
          </Text>
        </View>
      )}
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
      <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />
      <View style={styles.row}>
        <Text variant="bodyStrong">{t('payments.breakdownTotal')}</Text>
        <Text variant="title3" tabular>
          {formatPEN(payment.amountCents)}
        </Text>
      </View>
      <View style={[styles.row, {marginTop: theme.spacing.xs}]}>
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
function ProcessingBody({
  title,
  hint,
}: {
  title: string;
  hint: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: theme.spacing.md,
        alignItems: 'center',
        paddingVertical: theme.spacing.md,
      }}>
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
  const {t} = useTranslation();
  return (
    <CheckoutInstructions
      payment={payment}
      onRetry={onRetry}
      retrying={retrying}
      // CIP (PagoEfectivo): hint HONESTO — se paga en banco/agente horas/días después; "esta pantalla
      // se actualiza sola" retiene a alguien que tiene que salir. Yape/Plin/tarjeta resuelven en
      // minutos → conservan el hint genérico.
      waitingHint={
        payment.cip ? t('settlement.checkout.waitingHintCip') : undefined
      }
      header={
        <View style={{gap: theme.spacing.md}}>
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
function TipChip({
  label,
  onPress,
  tabular = false,
  loading = false,
  disabled = false,
}: TipChipProps): React.JSX.Element {
  const theme = useTheme();
  const {animatedStyle, onPressIn, onPressOut} = usePressScale();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      hitSlop={8}>
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
        ]}>
        <Text
          variant="bodyStrong"
          color={loading ? 'inkMuted' : 'ink'}
          tabular={tabular}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  divider: {height: 1, marginVertical: 8},
  chips: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {alignItems: 'center', justifyContent: 'center', minHeight: 44},
});
