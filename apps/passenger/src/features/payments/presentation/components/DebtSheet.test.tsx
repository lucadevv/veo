import type {DebtView, PaymentView} from '@veo/api-client';
import {NavigationContainer} from '@react-navigation/native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import type {
  ChangePaymentMethodUseCase,
  GetPaymentUseCase,
  RetryChargeUseCase,
} from '../../domain/usecases';
import {
  PaymentMethodNotApplicableError,
  PaymentNotChangeableError,
} from '../../domain/usecases';
import {usePaymentPrefsStore} from '../stores/paymentPrefsStore';
import {DebtSheet, classifyResolveFailure} from './DebtSheet';

/** Deuda con una sola entrada (la más común): monto + un `reason` opcional para el mensaje honesto. */
function debtView(over?: {reason?: string; amountCents?: number}): DebtView {
  const amountCents = over?.amountCents ?? 4200;
  return {
    hasDebt: true,
    totalCents: amountCents,
    debts: [
      {
        paymentId: 'pay-debt',
        tripId: 'trip-debt',
        amountCents,
        reason: over?.reason ?? '',
        createdAt: '2026-06-01T10:00:00.000Z',
        kind: 'DEBT',
      },
    ],
  } as DebtView;
}

// `useReducedMotion` (ui-kit) usa AccessibilityInfo; el preset de RN no lo implementa. Stubs seguros.
{
  const {AccessibilityInfo} = jest.requireActual('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({remove: jest.fn()});
}

const INITIAL_METRICS = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

function paymentView(over: Partial<PaymentView>): PaymentView {
  return {
    id: 'pay-pa',
    tripId: 'trip-pa',
    method: 'YAPE',
    status: 'PENDING',
    amountCents: 3600,
    grossCents: 3000,
    tipCents: 0,
    commissionCents: 600,
    feeCents: 600,
    externalRef: '',
    externalUid: '01KTHPQ6RPD4J2P7NWFKGRNPJG',
    checkoutUrl: null,
    qrCode: null,
    deepLink: 'yapeapp:oneshot/abc',
    cip: null,
    checkoutExpiresAt: null,
    ...over,
  } as PaymentView;
}

function registerDeps(opts: {
  getPayment: jest.Mock;
  retryCharge?: jest.Mock;
  changeMethod?: jest.Mock;
}): void {
  container.register(
    TOKENS.getPaymentUseCase,
    () => ({execute: opts.getPayment}) as unknown as GetPaymentUseCase,
  );
  container.register(
    TOKENS.retryChargeUseCase,
    () =>
      ({
        execute: opts.retryCharge ?? jest.fn(),
      }) as unknown as RetryChargeUseCase,
  );
  container.register(
    TOKENS.changePaymentMethodUseCase,
    () =>
      ({
        execute: opts.changeMethod ?? jest.fn(),
      }) as unknown as ChangePaymentMethodUseCase,
  );
}

let activeClient: QueryClient | null = null;

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  activeClient = client;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <QueryClientProvider client={client}>
          <NavigationContainer>
            <ThemeProvider>{node}</ThemeProvider>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(n =>
      Array.isArray(n.props.children) ? n.props.children : [n.props.children],
    )
    .filter((c): c is string => typeof c === 'string');
}

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
  container.reset();
});

describe('DebtSheet · modo PAGO POR COMPLETAR (PENDING_ACTION)', () => {
  it('carga el cobro FRESCO por id y abre DIRECTO el checkout (sin retry-charge)', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'PENDING'}));
    const retryCharge = jest.fn();
    registerDeps({getPayment, retryCharge});

    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    // Resuelve el dead-end: lee el cobro fresco por id, NO dispara un re-cobro (no es una deuda).
    expect(getPayment).toHaveBeenCalledWith('pay-pa');
    expect(retryCharge).not.toHaveBeenCalled();
    // Y muestra el checkout directo (deepLink → "Pagar con Yape") con el encabezado HONESTO (TASK 3):
    // "Pago de tu viaje · S/X" + el método actual claro + el CTA secundario para cambiar de método.
    const out = texts(renderer);
    expect(out).toContain('Pagar con Yape');
    expect(out).toContain('Pago de tu viaje');
    expect(out).toContain('S/ 36.00');
    expect(out).toContain('Método actual: Yape');
    expect(out).toContain('Pagar con otro método');

    act(() => renderer.unmount());
  });

  it('si el cobro ya CAPTURÓ entre medio → muestra el éxito (no un checkout muerto)', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'CAPTURED'}));
    registerDeps({getPayment});

    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    expect(texts(renderer)).toContain('¡Listo!');
    act(() => renderer.unmount());
  });

  it('si el cobro ya no tiene checkout vivo (PENDING sin medios) → estado honesto, no checkout', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(
        paymentView({status: 'PENDING', deepLink: null, externalUid: null}),
      );
    registerDeps({getPayment});

    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    expect(texts(renderer)).toContain('Este pago ya no está pendiente');
    act(() => renderer.unmount());
  });
});

/** Presiona el primer Pressable (rol button) cuyo accessibilityLabel contiene `label` y tiene onPress. */
async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): Promise<void> {
  const btn = renderer.root
    .findAllByProps({accessibilityRole: 'button'})
    .find(
      b =>
        typeof b.props.accessibilityLabel === 'string' &&
        b.props.accessibilityLabel.includes(label) &&
        typeof b.props.onPress === 'function' &&
        !b.props.accessibilityState?.disabled,
    );
  if (!btn) {
    throw new Error(
      `No se encontró un botón habilitado con label que incluya "${label}"`,
    );
  }
  await act(async () => {
    btn.props.onPress();
    await Promise.resolve();
  });
  await flush();
}

describe('DebtSheet · TASK 3 · cambiar de método (DIGITAL)', () => {
  it('"Pagar con otro método" abre el selector con SOLO digitales (sin Efectivo)', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'PENDING'}));
    registerDeps({getPayment});
    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    await pressByLabel(renderer, 'Pagar con otro método');

    const out = texts(renderer);
    expect(out).toContain('Elige otro método');
    // Digitales presentes…
    expect(out).toEqual(
      expect.arrayContaining(['Yape', 'Plin', 'Tarjeta', 'PagoEfectivo']),
    );
    // …y Efectivo NUNCA (no se puede cambiar a efectivo un cobro digital pendiente).
    expect(out).not.toContain('Efectivo');
    act(() => renderer.unmount());
  });

  it('elegir Plin → POST cambia el método y re-renderiza con el checkout NUEVO (web → "Pagar ahora")', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'PENDING'}));
    // El server devuelve el cobro con el checkout NUEVO del método elegido (Plin → QR/web).
    const changeMethod = jest.fn().mockResolvedValue(
      paymentView({
        method: 'PLIN',
        status: 'PENDING',
        deepLink: null,
        checkoutUrl: 'https://pay.veo.pe/plin/abc',
      }),
    );
    registerDeps({getPayment, changeMethod});
    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();
    await pressByLabel(renderer, 'Pagar con otro método');
    await pressByLabel(renderer, 'Plin');

    // Llamó al cambio con el id del pago y el método elegido…
    expect(changeMethod).toHaveBeenCalledWith('pay-pa', 'PLIN');
    // …y volvió al checkout con el medio NUEVO (urlPay web → "Pagar ahora") + método actual = Plin.
    const out = texts(renderer);
    expect(out).toContain('Pagar ahora');
    expect(out).toContain('Método actual: Plin');
    act(() => renderer.unmount());
  });

  it('409 (ya no cambiable) → estado honesto "este pago ya no está pendiente"', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'PENDING'}));
    const changeMethod = jest
      .fn()
      .mockRejectedValue(new PaymentNotChangeableError());
    registerDeps({getPayment, changeMethod});
    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();
    await pressByLabel(renderer, 'Pagar con otro método');
    await pressByLabel(renderer, 'Tarjeta');

    expect(texts(renderer)).toContain('Este pago ya no está pendiente');
    act(() => renderer.unmount());
  });

  it('422 (método no aplica) → banner honesto, el selector sigue abierto para reintentar', async () => {
    const getPayment = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'PENDING'}));
    const changeMethod = jest
      .fn()
      .mockRejectedValue(new PaymentMethodNotApplicableError());
    registerDeps({getPayment, changeMethod});
    const renderer = render(
      <DebtSheet
        visible
        debt={null}
        pendingActionPaymentId="pay-pa"
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();
    await pressByLabel(renderer, 'Pagar con otro método');
    await pressByLabel(renderer, 'PagoEfectivo');

    const out = texts(renderer);
    expect(out).toContain('Ese método no aplica');
    // Sigue en el selector (no salta a un estado terminal): el título del selector permanece.
    expect(out).toContain('Elige otro método');
    act(() => renderer.unmount());
  });
});

describe('DebtSheet · DEBT idle · RESOLVER CON SELECTOR', () => {
  beforeEach(() => {
    // Cada test arranca con el predeterminado canónico (YAPE) salvo que lo cambie explícitamente.
    usePaymentPrefsStore.getState().setDefault('YAPE');
  });

  it('muestra el selector SIEMPRE (canónico, digitales sin Efectivo) y destaca el DEFAULT digital', async () => {
    registerDeps({getPayment: jest.fn()});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView()}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    const out = texts(renderer);
    // Encabezado honesto + monto.
    expect(out).toContain('Resuelve el pago de tu viaje');
    expect(out).toContain('S/ 42.00');
    // El selector canónico con TODOS los digitales y SIN Efectivo (no aplica a un pago ya hecho).
    expect(out).toEqual(
      expect.arrayContaining(['Yape', 'Plin', 'Tarjeta', 'PagoEfectivo']),
    );
    expect(out).not.toContain('Efectivo');
    // El SUGERIDO es el predeterminado del perfil (YAPE) → pill "Sugerido" + el CTA lo refleja.
    expect(out).toContain('Sugerido');
    expect(out).toContain('Pagar con Yape');
    act(() => renderer.unmount());
  });

  it('cuando el default es CASH (no aplica), sugiere el primer digital (YAPE) y NO ofrece Efectivo', async () => {
    usePaymentPrefsStore.getState().setDefault('CASH');
    registerDeps({getPayment: jest.fn()});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView()}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    const out = texts(renderer);
    expect(out).toContain('Pagar con Yape'); // primer digital como sugerido
    expect(out).not.toContain('Efectivo');
    act(() => renderer.unmount());
  });

  it('elegir Plin y confirmar → changeMethod(:id, PLIN); si vuelve PENDING+checkout → muestra el checkout', async () => {
    const changeMethod = jest.fn().mockResolvedValue(
      paymentView({
        method: 'PLIN',
        status: 'PENDING',
        deepLink: null,
        checkoutUrl: 'https://pay.veo.pe/plin/abc',
      }),
    );
    registerDeps({getPayment: jest.fn(), changeMethod});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView()}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    // Elige Plin en el selector (solo elige, no cobra) → el CTA pasa a "Pagar con Plin".
    await pressByLabel(renderer, 'Plin');
    expect(texts(renderer)).toContain('Pagar con Plin');
    // Confirma con el CTA primario.
    await pressByLabel(renderer, 'Pagar con Plin');

    expect(changeMethod).toHaveBeenCalledWith('pay-debt', 'PLIN');
    // Volvió al checkout del método elegido (web → "Pagar ahora").
    expect(texts(renderer)).toContain('Pagar ahora');
    act(() => renderer.unmount());
  });

  it('elegir el método ORIGINAL (changeMethod no-op → sigue DEBT) → cae a retryCharge', async () => {
    // El backend hace no-op cuando el método == original: devuelve el pago aún en DEBT.
    const changeMethod = jest
      .fn()
      .mockResolvedValue(paymentView({method: 'YAPE', status: 'DEBT'}));
    const retryCharge = jest
      .fn()
      .mockResolvedValue(paymentView({method: 'YAPE', status: 'CAPTURED'}));
    registerDeps({getPayment: jest.fn(), changeMethod, retryCharge});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView()}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    // Confirma con el sugerido (YAPE) → changeMethod no-op (DEBT) → fallback retryCharge → CAPTURED.
    await pressByLabel(renderer, 'Pagar con Yape');

    expect(changeMethod).toHaveBeenCalledWith('pay-debt', 'YAPE');
    expect(retryCharge).toHaveBeenCalledWith('pay-debt');
    expect(texts(renderer)).toContain('¡Listo!');
    act(() => renderer.unmount());
  });

  it('si el cobro vuelve a DEBT con reason capability → mensaje HONESTO por-método (no el genérico)', async () => {
    // changeMethod devuelve DEBT, retryCharge también DEBT (no saldó). El reason de la deuda es capability.
    const changeMethod = jest
      .fn()
      .mockResolvedValue(paymentView({method: 'YAPE', status: 'DEBT'}));
    const retryCharge = jest
      .fn()
      .mockResolvedValue(paymentView({method: 'YAPE', status: 'DEBT'}));
    registerDeps({getPayment: jest.fn(), changeMethod, retryCharge});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView({reason: 'method_unavailable:YAPE'})}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();
    await pressByLabel(renderer, 'Pagar con Yape');

    const out = texts(renderer);
    // Mensaje honesto por-método (capability), NO el genérico "no pudimos procesar".
    expect(out).toContain('Yape no está disponible ahora');
    expect(out).toContain('Elige otro método para pagar tu viaje.');
    act(() => renderer.unmount());
  });

  it('si TODOS los digitales fallan → mensaje honesto + escape claro (sin bucle infinito)', async () => {
    // Cada intento vuelve a DEBT (no saldó) por cualquier método.
    const changeMethod = jest
      .fn()
      .mockImplementation((_id, method) =>
        Promise.resolve(paymentView({method, status: 'DEBT'})),
      );
    const retryCharge = jest
      .fn()
      .mockResolvedValue(paymentView({method: 'YAPE', status: 'DEBT'}));
    registerDeps({getPayment: jest.fn(), changeMethod, retryCharge});
    const renderer = render(
      <DebtSheet
        visible
        debt={debtView()}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    await flush();

    // Prueba los 4 digitales (YAPE sugerido + PLIN/CARD/PAGOEFECTIVO), cada uno falla.
    await pressByLabel(renderer, 'Pagar con Yape');
    await pressByLabel(renderer, 'Plin');
    await pressByLabel(renderer, 'Pagar con Plin');
    await pressByLabel(renderer, 'Tarjeta');
    await pressByLabel(renderer, 'Pagar con Tarjeta');
    await pressByLabel(renderer, 'PagoEfectivo');
    await pressByLabel(renderer, 'Pagar con PagoEfectivo');

    const out = texts(renderer);
    expect(out).toContain('Ningún método pudo procesar tu pago');
    // Escape claro presente; el selector ya no se ofrece (no hay bucle).
    expect(out).toContain('Volver más tarde');
    expect(out).not.toContain('Sugerido');
    act(() => renderer.unmount());
  });
});

describe('classifyResolveFailure · lectura defensiva del motivo', () => {
  it('capability/method-unavailable → methodUnavailable + método parseado', () => {
    expect(classifyResolveFailure('method_unavailable:PAGOEFECTIVO')).toEqual({
      kind: 'methodUnavailable',
      method: 'PAGOEFECTIVO',
    });
    expect(classifyResolveFailure('PAGOEFECTIVO_UNAVAILABLE')?.kind).toBe(
      'methodUnavailable',
    );
  });

  it('motivos transitorios / desconocidos → transient (reintentable)', () => {
    expect(classifyResolveFailure('gateway_error')?.kind).toBe('transient');
    expect(classifyResolveFailure('yape_insufficient_funds')?.kind).toBe(
      'transient',
    );
    expect(classifyResolveFailure('unknown')?.kind).toBe('transient');
  });

  it('vacío / no-string → null (sin fallo que mostrar)', () => {
    expect(classifyResolveFailure('')).toBeNull();
    expect(classifyResolveFailure(null)).toBeNull();
    expect(classifyResolveFailure(undefined)).toBeNull();
  });
});
