import type {
  DebtItemView,
  DebtView,
  MobileDigitalPaymentMethod,
  MobilePaymentMethod,
  PaymentView,
} from '@veo/api-client';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {Banner, BottomSheet, Button, Card, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatDateTime, formatPEN} from '../../../../shared/utils/format';
import {type ChangeablePaymentMethod} from '../../domain/paymentsRepository';
import {
  PaymentMethodNotApplicableError,
  PaymentNotChangeableError,
} from '../../domain/usecases';
import {
  assertNever,
  interpretPaymentOutcome,
  isPaymentSettled,
} from '../../domain/paymentOutcome';
import {CheckoutInstructions} from './CheckoutInstructions';
import {PaymentMethodPicker} from './PaymentMethodPicker';
import {
  DIGITAL_PAYMENT_METHODS,
  usePaymentPrefsStore,
} from '../stores/paymentPrefsStore';
import {MY_DEBTS_QUERY_KEY} from '../hooks/useMyDebts';
import {EnterView, SuccessCheck} from './motion';

/** Cadencia del poll del cobro mientras espera la confirmación del checkout (webhook ProntoPaga). */
const POLL_INTERVAL_MS = 2500;

export interface DebtSheetProps {
  visible: boolean;
  /** Deuda a saldar (de `GET /payments/debts` o derivada del 403 del gate). El sheet salda la 1ª (más antigua). */
  debt: DebtView | null;
  /**
   * MODO PENDING_ACTION: id de un Payment PENDING con checkout vivo ("pago por completar"). Si viene, el
   * sheet IGNORA el flujo de deuda (no hace retry-charge) y abre DIRECTO el checkout del payment: lee el
   * cobro FRESCO (`GET /payments/:id`) y muestra sus medios (deepLink Yape / web / QR / CIP) con el poll a
   * CAPTURED. Es el dead-end que resolvemos: un pago a medio completar al que el usuario puede VOLVER.
   */
  pendingActionPaymentId?: string | null;
  /** Cierra el sheet (escape "Ahora no" o tras saldar desde el home). */
  onClose: () => void;
  /**
   * La deuda quedó SALDADA (CAPTURED). El llamador decide qué hacer: si vino de un pedido bloqueado,
   * re-intenta el pedido; si vino de la franja del home, simplemente cierra. Recibe la señal para
   * limpiar la franja (invalida la caché de deudas) y, si aplica, re-disparar el flujo del pedido.
   */
  onSettled: () => void;
}

/**
 * Estado interno del flujo de saldar:
 *  - `idle`: muestra el resumen de la deuda + "Pagar ahora".
 *  - `loading`: (solo modo PENDING_ACTION) cargando el cobro fresco para abrir su checkout.
 *  - `checkout`: el re-cobro volvió PENDING con checkout (ProntoPaga) → mostramos cómo pagar + poll.
 *  - `settled`: el cobro quedó CAPTURED (saldó directo o tras completar el checkout) → éxito.
 *  - `unavailable`: (modo PENDING_ACTION) el cobro ya no tiene checkout vivo (capturó/venció) — honesto.
 */
type Phase = 'idle' | 'loading' | 'checkout' | 'settled' | 'unavailable';

/**
 * CLASE de un fallo de cobro, para un mensaje HONESTO por-método (en vez del genérico "no pudimos
 * procesar" en bucle):
 *  - `methodUnavailable`: el riel/método no está disponible ahora (capacidad) → invita a ELEGIR OTRO.
 *  - `transient`: algo pasajero (red, gateway ocupado) → invita a reintentar en un momento.
 */
export type ResolveFailureKind = 'methodUnavailable' | 'transient';

export interface ResolveFailure {
  kind: ResolveFailureKind;
  /** Método al que apunta el fallo (si el reason lo trae, p. ej. `method_unavailable:PAGOEFECTIVO`). */
  method?: MobilePaymentMethod;
}

const PAYMENT_METHOD_VALUES: readonly MobilePaymentMethod[] = [
  'YAPE',
  'PLIN',
  'CASH',
  'CARD',
  'PAGOEFECTIVO',
];

/**
 * Clasifica el fallo de un cobro a partir de la información DISPONIBLE, de forma DEFENSIVA.
 *
 * Fuentes del reason (ambas YA en el contrato): el `paymentView` expone `failureReason` (string
 * estructurado, p. ej. `method_unavailable:PAGOEFECTIVO`, `declined`; nullable/opcional ⇒ compat con
 * backends viejos) — el dominio lo lee en el outcome `debt` — y el `debtItemView.reason` (string
 * normalizado, p. ej. `yape_insufficient_funds`, `gateway_error`, `unknown`) queda como FALLBACK
 * cuando el payment no lo trae. Esta función interpreta cualquiera de los dos con la misma heurística.
 *
 * Heurística (case-insensitive):
 *  - `method_unavailable[:METHOD]` o `*_unavailable` / `capability*` / `not_supported` → methodUnavailable.
 *  - resto (gateway/red/insufficient/declined/unknown) → transient (reintentable).
 */
export function classifyResolveFailure(
  rawReason: unknown,
): ResolveFailure | null {
  if (typeof rawReason !== 'string' || rawReason.trim() === '') {
    return null;
  }
  const reason = rawReason.trim().toLowerCase();
  const colon = reason.indexOf(':');
  const code = colon >= 0 ? reason.slice(0, colon) : reason;
  const methodPart = colon >= 0 ? reason.slice(colon + 1) : undefined;
  const method = methodPart
    ? PAYMENT_METHOD_VALUES.find(m => m.toLowerCase() === methodPart.trim())
    : undefined;
  const unavailable =
    code.includes('method_unavailable') ||
    code.includes('unavailable') ||
    code.includes('capability') ||
    code.includes('not_supported') ||
    code.includes('unsupported');
  return {kind: unavailable ? 'methodUnavailable' : 'transient', method};
}

/**
 * Sheet de DEUDA / PAGO POR COMPLETAR (BR-P02). Dos orígenes:
 *  - DEUDA (kind=DEBT): el pasajero intentó pedir con una deuda (403 `DEBT_PENDING`) o tocó la franja
 *    "Resolver". Resumen honesto + "Pagar ahora" → `retry-charge`; si vuelve PENDING con checkout, reusa
 *    `CheckoutInstructions` + poll a CAPTURED.
 *  - PAGO POR COMPLETAR (kind=PENDING_ACTION, via `pendingActionPaymentId`): un Payment PENDING con un
 *    checkout VIVO esperando acción. El sheet abre DIRECTO el checkout del cobro FRESCO (`GET /payments/:id`)
 *    — sin retry-charge, porque el cobro ya está en curso — con el mismo poll a CAPTURED. Resuelve el
 *    dead-end: antes, cerrar el sheet dejaba ese pago inalcanzable.
 *
 * NO castiga: tono sobrio, escape "Ahora no" SIEMPRE visible.
 */
export function DebtSheet({
  visible,
  debt,
  pendingActionPaymentId,
  onClose,
  onSettled,
}: DebtSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();
  const retryCharge = useDependency(TOKENS.retryChargeUseCase);
  const getPaymentById = useDependency(TOKENS.getPaymentUseCase);
  const changePaymentMethod = useDependency(TOKENS.changePaymentMethodUseCase);

  const isPendingAction = Boolean(pendingActionPaymentId);

  const [phase, setPhase] = React.useState<Phase>('idle');
  // El cobro en vuelo (tras retry-charge o cargado fresco en modo PENDING_ACTION): su id alimenta el poll
  // del checkout y su vista los medios.
  const [pendingPayment, setPendingPayment] =
    React.useState<PaymentView | null>(null);
  // TASK 3 · ¿El selector "Pagar con otro método" (digitales) está abierto sobre el checkout actual?
  const [changeMethodOpen, setChangeMethodOpen] = React.useState(false);

  // RESOLVER CON SELECTOR (DEBT en fase idle). El método DIGITAL elegido para saldar (lo destaca el
  // picker y alimenta el CTA "Pagar con X"). Arranca en el predeterminado del perfil si es digital.
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);
  // El predeterminado solo sirve como SUGERENCIA si es digital (CASH no aplica a un pago ya hecho).
  const suggestedMethod = React.useMemo<MobileDigitalPaymentMethod>(() => {
    if (DIGITAL_PAYMENT_METHODS.includes(defaultMethod)) {
      return defaultMethod as MobileDigitalPaymentMethod;
    }
    return DIGITAL_PAYMENT_METHODS[0] as MobileDigitalPaymentMethod;
  }, [defaultMethod]);
  const [selectedMethod, setSelectedMethod] =
    React.useState<MobileDigitalPaymentMethod>(suggestedMethod);
  // Métodos digitales que YA se probaron y fallaron en esta sesión del sheet: si se agotan todos, el
  // mensaje es honesto y hay escape — NUNCA un bucle infinito sin salida.
  const [triedMethods, setTriedMethods] = React.useState<
    Set<MobileDigitalPaymentMethod>
  >(() => new Set());
  // Fallo clasificado del último intento (mensaje honesto por-método). null = aún sin fallo.
  const [resolveFailure, setResolveFailure] =
    React.useState<ResolveFailure | null>(null);

  const debts = debt?.debts ?? [];
  // Saldamos SIEMPRE la más antigua (el backend lista de más antigua a más nueva). El gate se libera
  // cuando NO queda deuda; empezar por la más vieja es el orden natural de regularización.
  const target: DebtItemView | null = debts[0] ?? null;
  const totalCents = debt?.totalCents ?? 0;

  /** Invalida la franja del home (deudas + pagos por completar) para que refleje el estado real. */
  const invalidateDebts = React.useCallback(() => {
    void queryClient.invalidateQueries({queryKey: MY_DEBTS_QUERY_KEY});
  }, [queryClient]);

  /** Marca como saldado/completado: invalida la franja del home y muestra el éxito. */
  const markSettled = React.useCallback(() => {
    invalidateDebts();
    setPhase('settled');
  }, [invalidateDebts]);

  // Cierre del sheet: invalida la franja ANTES de cerrar (al cerrar el sheet el estado pudo cambiar —
  // p.ej. completó el pago en otra app y volvió, o el poll lo movió). Evita la franja con cache viejo.
  const handleClose = React.useCallback(() => {
    invalidateDebts();
    onClose();
  }, [invalidateDebts, onClose]);

  // Reinicia el estado interno cada vez que el sheet se abre (no arrastrar un éxito/checkout viejo). En
  // modo PENDING_ACTION arranca en 'loading' (va a cargar el cobro fresco); en deuda, en 'idle'.
  React.useEffect(() => {
    if (visible) {
      setPhase(isPendingAction ? 'loading' : 'idle');
      setPendingPayment(null);
      setChangeMethodOpen(false);
      // Arranca el selector de resolución en el SUGERIDO (predeterminado digital) y limpia el historial
      // de intentos/fallos: cada apertura del sheet es un intento limpio.
      setSelectedMethod(suggestedMethod);
      setTriedMethods(new Set());
      setResolveFailure(null);
    }
  }, [visible, isPendingAction, suggestedMethod]);

  // MODO PENDING_ACTION: carga el cobro FRESCO (GET /payments/:id) y abre su checkout. Si ya no tiene
  // checkout vivo (capturó entre medio, o venció), estado honesto en vez de un checkout muerto.
  React.useEffect(() => {
    if (
      !visible ||
      !isPendingAction ||
      phase !== 'loading' ||
      !pendingActionPaymentId
    ) {
      return;
    }
    let cancelled = false;
    void getPaymentById
      .execute(pendingActionPaymentId)
      .then(payment => {
        if (cancelled) {
          return;
        }
        // Switch EXHAUSTIVO sobre el resultado de DOMINIO: un PaymentStatus nuevo obliga acá
        // en compile-time (assertNever) — no más fallthrough silencioso.
        const outcome = interpretPaymentOutcome(payment);
        switch (outcome.kind) {
          case 'settled':
            // Ya se completó (webhook entró): éxito directo, sin checkout.
            markSettled();
            return;
          case 'checkoutPending':
            setPendingPayment(payment);
            setPhase('checkout');
            return;
          case 'processing':
          case 'cashPending':
          case 'debt':
          case 'failed':
          case 'refunded':
            // PENDING sin checkout, DEBT, FAILED…: ya no es un pago por completar accionable.
            setPhase('unavailable');
            return;
          default:
            assertNever(outcome);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    isPendingAction,
    phase,
    pendingActionPaymentId,
    getPaymentById,
    markSettled,
  ]);

  // Poll del cobro mientras espera la confirmación del checkout (PENDING → CAPTURED por webhook). Lee el
  // cobro por id; al CAPTURED, marca saldado. Solo activo en la rama de checkout con un cobro en vuelo.
  const pollQuery = useQuery<PaymentView, Error>({
    queryKey: ['payment', pendingPayment?.id, 'debt-poll'],
    queryFn: () => getPaymentById.execute(pendingPayment!.id),
    enabled: phase === 'checkout' && Boolean(pendingPayment?.id),
    refetchInterval: query => {
      const data = query.state.data;
      if (data && isPaymentSettled(data)) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  // El cobro se confirmó por el poll del checkout → éxito (sin tocar la fuente del recibo del viaje).
  React.useEffect(() => {
    if (
      phase === 'checkout' &&
      pollQuery.data &&
      isPaymentSettled(pollQuery.data)
    ) {
      markSettled();
    }
  }, [phase, pollQuery.data, markSettled]);

  /**
   * RESOLVER CON SELECTOR (DEBT en fase idle). El usuario ELIGE un método digital y confirma. Estrategia
   * UNIFICADA, apoyada en el contrato del backend (`POST /payments/:id/method` acepta DEBT y PENDING):
   *  - `changeMethod(id, chosen)` re-cobra con el método ELEGIDO (CAPTURED · PENDING+checkout · de vuelta
   *    a DEBT). Si `chosen == método original` del cobro, el backend hace NO-OP (devuelve DEBT sin re-cobrar):
   *    como la app NO conoce el método original de un DEBT, detectamos ese no-op (sigue en DEBT) y caemos a
   *    `retryCharge(id)` para re-intentar ese MISMO método. Así cubrimos "elegido == actual → retryCharge;
   *    elegido != actual → changeMethod" sin tener que leer el método original de antemano.
   */
  const resolveOutcome = React.useCallback(
    (payment: PaymentView, method: MobileDigitalPaymentMethod) => {
      // Switch EXHAUSTIVO sobre el resultado de DOMINIO (assertNever): la interpretación del cobro
      // vive en `interpretPaymentOutcome`; acá solo se elige la rama de UI.
      const outcome = interpretPaymentOutcome(payment);
      switch (outcome.kind) {
        case 'settled':
          // Saldó directo: éxito inmediato.
          markSettled();
          return;
        case 'checkoutPending':
          // Requiere completar el pago fuera de banda: mostramos el checkout del método elegido + poll.
          setPendingPayment(payment);
          setResolveFailure(null);
          setPhase('checkout');
          return;
        case 'processing':
        case 'cashPending':
        case 'debt':
        case 'failed':
        case 'refunded': {
          // Volvió a DEBT (o PENDING mudo sin checkout): ese método NO saldó. Lo marcamos como probado para
          // no ofrecer un bucle infinito sobre lo mismo, clasificamos el fallo HONESTO y quedamos en idle.
          setPendingPayment(payment);
          setTriedMethods(prev => new Set(prev).add(method));
          // Motivo del fallo: el `failureReason` ESTRUCTURADO que el dominio leyó del cobro en DEBT
          // (ver `classifyResolveFailure`) y, si falta, el `reason` de la deuda objetivo.
          const rawReason =
            (outcome.kind === 'debt' ? outcome.failureReason : null) ??
            target?.reason ??
            null;
          setResolveFailure(
            classifyResolveFailure(rawReason) ?? {kind: 'transient'},
          );
          setPhase('idle');
          return;
        }
        default:
          assertNever(outcome);
      }
    },
    [markSettled, target],
  );

  const resolveMutation = useMutation<
    PaymentView,
    Error,
    {paymentId: string; method: MobileDigitalPaymentMethod}
  >({
    mutationFn: async ({paymentId, method}) => {
      // Cambia al método ELEGIDO (re-cobra). Si el backend hace no-op (método == original → sigue DEBT),
      // disparamos retry-charge para re-intentar ese mismo método (no quedarnos sin re-cobro).
      const changed = await changePaymentMethod.execute(paymentId, method);
      if (interpretPaymentOutcome(changed).kind === 'debt') {
        return retryCharge.execute(paymentId);
      }
      return changed;
    },
    onSuccess: (payment, {method}) => resolveOutcome(payment, method),
    onError: (_err, {method}) => {
      // Throw de red/contrato: marcamos el método como probado y mostramos un fallo transitorio honesto
      // (deja reintentar o elegir otro). No es un estado terminal: el selector sigue disponible.
      setTriedMethods(prev => new Set(prev).add(method));
      setResolveFailure({kind: 'transient', method});
    },
  });

  // Reintenta el poll del checkout (tras pagar, el webhook pasa a CAPTURED y el refetch lo refleja).
  const retryPoll = React.useCallback(() => {
    void pollQuery.refetch();
  }, [pollQuery]);

  // TASK 3 · Cambia el método del pago pendiente a otro DIGITAL → checkout NUEVO + sigue el poll.
  const changeMethodMutation = useMutation<
    PaymentView,
    Error,
    {paymentId: string; method: ChangeablePaymentMethod}
  >({
    mutationFn: ({paymentId, method}) =>
      changePaymentMethod.execute(paymentId, method),
    onSuccess: payment => {
      setChangeMethodOpen(false);
      // Switch EXHAUSTIVO sobre el resultado de DOMINIO (assertNever): mismo intérprete que el resto.
      const outcome = interpretPaymentOutcome(payment);
      switch (outcome.kind) {
        case 'settled':
          // Cambió y capturó de una (poco común, pero honesto): éxito directo.
          markSettled();
          return;
        case 'checkoutPending':
          // El caso esperado: el server devolvió el checkout NUEVO del método elegido → re-render + poll.
          setPendingPayment(payment);
          setPhase('checkout');
          return;
        case 'processing':
        case 'cashPending':
        case 'debt':
        case 'failed':
        case 'refunded':
          // PENDING sin checkout (u otro estado no accionable): el método no produjo medios → honesto.
          setPhase('unavailable');
          return;
        default:
          assertNever(outcome);
      }
    },
    onError: err => {
      // 409 (ya no cambiable): el pago cambió de estado → estado honesto, no insistir con un checkout muerto.
      if (err instanceof PaymentNotChangeableError) {
        setChangeMethodOpen(false);
        setPhase('unavailable');
      }
      // 422 (método no aplica) y errores de red: el banner del selector los muestra; el sheet sigue abierto.
    },
  });

  // ── Cuerpo según fase ────────────────────────────────────────────────────────────────────────
  let body: React.JSX.Element;

  if (phase === 'settled') {
    body = (
      <View style={{gap: theme.spacing.md, alignItems: 'center'}}>
        <SuccessCheck />
        <EnterView delay={140}>
          <View style={{gap: theme.spacing.xs, alignItems: 'center'}}>
            <Text variant="title3" align="center">
              {t('debt.settledTitle')}
            </Text>
            <Text variant="callout" color="inkMuted" align="center">
              {t(isPendingAction ? 'debt.completedBody' : 'debt.settledBody')}
            </Text>
          </View>
        </EnterView>
        <View style={styles.fullWidth}>
          <Button
            label={t('actions.continue')}
            variant="primary"
            fullWidth
            onPress={onSettled}
          />
        </View>
      </View>
    );
  } else if (phase === 'loading') {
    // Modo PENDING_ACTION: cargando el cobro fresco para abrir su checkout.
    body = (
      <View style={{alignItems: 'center', paddingVertical: theme.spacing.xl}}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  } else if (phase === 'unavailable') {
    // El pago por completar ya no tiene un checkout vivo (capturó o venció): honesto + cerrar.
    body = (
      <View style={{gap: theme.spacing.md}}>
        <Banner
          tone="info"
          title={t('debt.pendingGoneTitle')}
          description={t('debt.pendingGoneBody')}
        />
        <Button
          label={t('debt.notNow')}
          variant="ghost"
          fullWidth
          onPress={handleClose}
        />
      </View>
    );
  } else if (phase === 'checkout' && pendingPayment) {
    // TASK 3 · Selector "Pagar con otro método" abierto SOBRE el checkout: solo digitales (efectivo NO).
    if (changeMethodOpen) {
      body = (
        <ChangeMethodPicker
          currentMethod={pendingPayment.method}
          changing={changeMethodMutation.isPending}
          error={
            changeMethodMutation.error instanceof
            PaymentMethodNotApplicableError
              ? 'notApplicable'
              : changeMethodMutation.isError
                ? 'generic'
                : null
          }
          onPick={method =>
            changeMethodMutation.mutate({paymentId: pendingPayment.id, method})
          }
          onCancel={() => {
            changeMethodMutation.reset();
            setChangeMethodOpen(false);
          }}
        />
      );
    } else {
      body = (
        <View style={{gap: theme.spacing.md}}>
          <CheckoutInstructions
            payment={pendingPayment}
            onRetry={retryPoll}
            retrying={pollQuery.isFetching}
            header={
              <View style={{gap: theme.spacing.xs}}>
                {/* Encabezado HONESTO (TASK 3): "Pago de tu viaje · S/X" + el método ACTUAL claro. */}
                <Text variant="footnote" color="inkMuted">
                  {t('debt.pendingPaymentLabel')}
                </Text>
                <Text variant="display" tabular>
                  {formatPEN(pendingPayment.amountCents)}
                </Text>
                <Text variant="callout" color="inkMuted">
                  {t('debt.currentMethod', {
                    method: t(
                      `payments.method.${pendingPayment.method.toUpperCase()}`,
                    ),
                  })}
                </Text>
              </View>
            }
          />
          {/* CTA secundario: cambiar a otro método DIGITAL sin abandonar el pago. */}
          <Button
            label={t('debt.changeMethodCta')}
            variant="secondary"
            fullWidth
            onPress={() => setChangeMethodOpen(true)}
          />
        </View>
      );
    }
  } else {
    // idle (DEBT): RESOLVER CON SELECTOR. Encabezado honesto + el usuario ELIGE con qué pagar (no solo
    // "reintentar el mismo método fallido"). Sin castigo visual: tono sobrio, monto claro, por qué honesto.
    const resolving = resolveMutation.isPending;
    // ¿Se probaron y fallaron TODOS los digitales? → sin salida de re-cobro: mensaje honesto + escape.
    const allTried = DIGITAL_PAYMENT_METHODS.every(m =>
      triedMethods.has(m as MobileDigitalPaymentMethod),
    );
    // Nombre es-PE del método elegido para los CTAs y mensajes ("Pagar con Yape", "Yape no está…").
    const selectedName = t(`payments.method.${selectedMethod}`);
    body = (
      <View style={{gap: theme.spacing.lg}}>
        {/* Encabezado HONESTO: "Resuelve el pago de tu viaje · S/X". */}
        <View style={{gap: theme.spacing.xs}}>
          <Text variant="footnote" color="inkMuted">
            {t('debt.resolveTitle')}
          </Text>
          <Text variant="display" tabular>
            {formatPEN(totalCents)}
          </Text>
          <Text variant="callout" color="inkMuted">
            {t('debt.reason')}
          </Text>
        </View>

        {/* Lista compacta solo si hay MÁS de una deuda (con una, el monto grande ya la representa). */}
        {debts.length > 1 ? (
          <View style={{gap: theme.spacing.sm}}>
            <Text variant="footnote" color="inkMuted">
              {t('debt.itemsTitle')}
            </Text>
            <Card variant="outlined" padding="md">
              <View style={{gap: theme.spacing.sm}}>
                {debts.map((item, index) => (
                  <View
                    key={item.paymentId}
                    style={[
                      styles.itemRow,
                      index > 0
                        ? {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: theme.colors.border,
                          }
                        : null,
                      index > 0 ? {paddingTop: theme.spacing.sm} : null,
                    ]}>
                    <Text
                      variant="subhead"
                      numberOfLines={1}
                      style={styles.itemLabel}>
                      {t('debt.itemLabel', {
                        date: formatDateTime(item.createdAt),
                      })}
                    </Text>
                    <Text variant="bodyStrong" tabular>
                      {formatPEN(item.amountCents)}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}

        {allTried ? (
          // TODOS los digitales fallaron: honesto + escape claro. NUNCA un bucle sin salida.
          <>
            <Banner
              tone="warn"
              title={t('debt.allMethodsFailedTitle')}
              description={t('debt.allMethodsFailedBody')}
            />
            <Button
              label={t('debt.tryLater')}
              variant="primary"
              fullWidth
              onPress={handleClose}
            />
            <Button
              label={t('debt.notNow')}
              variant="ghost"
              fullWidth
              onPress={handleClose}
            />
          </>
        ) : (
          <>
            {/* Mensaje HONESTO por-método del último fallo (capability vs transitorio). */}
            {resolveFailure ? (
              <Banner
                tone={
                  resolveFailure.kind === 'methodUnavailable'
                    ? 'warn'
                    : 'danger'
                }
                title={
                  resolveFailure.kind === 'methodUnavailable'
                    ? t('debt.methodUnavailableTitle', {
                        method: t(
                          `payments.method.${resolveFailure.method ?? selectedMethod}`,
                        ),
                      })
                    : t('debt.transientTitle')
                }
                description={
                  resolveFailure.kind === 'methodUnavailable'
                    ? t('debt.methodUnavailableBody')
                    : t('debt.transientBody')
                }
              />
            ) : (
              <Text variant="callout" color="inkMuted">
                {t('debt.resolveSubtitle')}
              </Text>
            )}

            {/* SELECTOR SIEMPRE (el canónico `PaymentMethodPicker`, variante compact): el usuario ELIGE.
                Destacamos el SUGERIDO (predeterminado digital del perfil) con `highlightedMethod`. Tocar
                una fila SOLO elige (no cobra): el cobro lo dispara el CTA primario de abajo. */}
            <PaymentMethodPicker
              variant="compact"
              methods={DIGITAL_PAYMENT_METHODS}
              highlightedMethod={selectedMethod}
              disabled={resolving}
              onSelect={method => {
                setSelectedMethod(method as MobileDigitalPaymentMethod);
                setResolveFailure(null);
              }}
            />

            <View style={{gap: theme.spacing.sm}}>
              {/* CTA primario que REFLEJA el método elegido: "Pagar con Yape" / "Pagar con tarjeta"… */}
              <Button
                label={
                  resolving
                    ? t('debt.payingWith', {method: selectedName})
                    : t('debt.payWith', {method: selectedName})
                }
                variant="primary"
                fullWidth
                loading={resolving}
                disabled={!target}
                onPress={() =>
                  target
                    ? resolveMutation.mutate({
                        paymentId: target.paymentId,
                        method: selectedMethod,
                      })
                    : undefined
                }
              />
              {/* Escape SIEMPRE visible: no saldar ahora. NO castiga: cerrar es una salida legítima. */}
              <Button
                label={t('debt.notNow')}
                variant="ghost"
                fullWidth
                onPress={handleClose}
              />
            </View>
          </>
        )}
      </View>
    );
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={handleClose}
      title={t(isPendingAction ? 'debt.continueSheetTitle' : 'debt.title')}>
      {body}
    </BottomSheet>
  );
}

interface ChangeMethodPickerProps {
  /** Método ACTUAL del pago (se atenúa en la lista; no tiene sentido "cambiar" al mismo). */
  currentMethod: string;
  /** El cambio está en vuelo (el server arma el checkout del método nuevo). */
  changing: boolean;
  /** Error a mostrar: 422 (método no aplica) o genérico de red. null = sin error. */
  error: 'notApplicable' | 'generic' | null;
  onPick: (method: ChangeablePaymentMethod) => void;
  onCancel: () => void;
}

/**
 * Selector de OTRO método para un pago pendiente (TASK 3). Reusa el componente CANÓNICO
 * `PaymentMethodPicker` (variante `compact`): mismas filas/logo/labels que el selector al pedir, pero
 * con semántica de ACCIÓN (cada fila dispara el cambio), sin radio, sin default-pill y sin remember —
 * completar un cobro ya iniciado NO es elegir un predeterminado.
 *
 * SOLO digitales (`DIGITAL_PAYMENT_METHODS`, derivado de la fuente canónica `PAYMENT_METHODS` quitando
 * efectivo): un cobro digital pendiente no se "cambia a efectivo" (el conductor ya se fue; el server
 * respondería 422). El método ACTUAL se atenúa y deshabilita (no se "cambia" al mismo). Cada elección
 * dispara `POST /payments/:id/method` y el sheet re-renderiza con el checkout NUEVO.
 */
function ChangeMethodPicker({
  currentMethod,
  changing,
  error,
  onPick,
  onCancel,
}: ChangeMethodPickerProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const current = currentMethod.toUpperCase() as MobilePaymentMethod;

  return (
    <View style={{gap: theme.spacing.md}}>
      <View style={{gap: theme.spacing.xs}}>
        <Text variant="title3">{t('debt.changeMethodTitle')}</Text>
        <Text variant="callout" color="inkMuted">
          {t('debt.changeMethodSubtitle')}
        </Text>
      </View>

      {error ? (
        <Banner
          tone={error === 'notApplicable' ? 'warn' : 'danger'}
          title={t(
            error === 'notApplicable'
              ? 'debt.changeMethodNotApplicableTitle'
              : 'debt.changeMethodError',
          )}
          description={
            error === 'notApplicable'
              ? t('debt.changeMethodNotApplicableBody')
              : undefined
          }
        />
      ) : null}

      <PaymentMethodPicker
        variant="compact"
        methods={DIGITAL_PAYMENT_METHODS}
        currentMethod={current}
        disabled={changing}
        // El subset es DIGITAL por construcción (CASH fuera): el método elegido es un
        // `ChangeablePaymentMethod` válido. El picker tipa genérico (`MobilePaymentMethod`) para servir a
        // las 3 superficies; acotamos en el borde, respaldados por la red de seguridad del BFF (422 ante CASH).
        onSelect={method => onPick(method as ChangeablePaymentMethod)}
      />

      <Button
        label={changing ? t('debt.changingMethod') : t('actions.back')}
        variant="ghost"
        fullWidth
        disabled={changing}
        loading={changing}
        onPress={onCancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fullWidth: {alignSelf: 'stretch'},
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  itemLabel: {flex: 1},
});
