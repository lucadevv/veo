import type {PaymentView} from '@veo/api-client';
import {NavigationContainer} from '@react-navigation/native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import i18n from '../../../../i18n';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import type {
  AddTipUseCase,
  ConfirmCashUseCase,
  GetPaymentByTripUseCase,
} from '../../domain/usecases';
import {SettlementBody} from './SettlementBody';

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
    id: 'pay-1',
    tripId: 'trip-1',
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
    deepLink: null,
    cip: null,
    checkoutExpiresAt: null,
    ...over,
  } as PaymentView;
}

function registerDeps(opts: {
  getPaymentByTrip: jest.Mock;
  confirmCash?: jest.Mock;
  addTip?: jest.Mock;
}): void {
  container.register(
    TOKENS.getPaymentByTripUseCase,
    () =>
      ({
        execute: opts.getPaymentByTrip,
      }) as unknown as GetPaymentByTripUseCase,
  );
  container.register(
    TOKENS.confirmCashUseCase,
    () => ({execute: opts.confirmCash ?? jest.fn()}) as unknown as ConfirmCashUseCase,
  );
  container.register(
    TOKENS.addTipUseCase,
    () => ({execute: opts.addTip ?? jest.fn()}) as unknown as AddTipUseCase,
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

/** Presiona el primer botón (rol button) cuyo accessibilityLabel contiene `label` y tiene onPress. */
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
        typeof b.props.onPress === 'function',
    );
  expect(btn).toBeDefined();
  await act(async () => {
    btn?.props.onPress();
  });
}

/** Presiona el primer botón (rol button) cuyo SUBÁRBOL contiene el texto exacto (chips sin label). */
async function pressByText(
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
): Promise<void> {
  const btn = renderer.root
    .findAllByProps({accessibilityRole: 'button'})
    .find(b => {
      if (typeof b.props.onPress !== 'function') {
        return false;
      }
      return b
        .findAllByType(Text)
        .some(n =>
          (Array.isArray(n.props.children)
            ? n.props.children
            : [n.props.children]
          ).includes(text),
        );
    });
  expect(btn).toBeDefined();
  await act(async () => {
    btn?.props.onPress();
  });
}

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
  container.reset();
});

describe('SettlementBody · checkout pendiente con salida "Pagar después"', () => {
  it('la rama de checkout ofrece "Pagar después" y sale por onFinish (cierre → franja del home)', async () => {
    const getPaymentByTrip = jest
      .fn()
      .mockResolvedValue(paymentView({deepLink: 'yapeapp:oneshot/abc'}));
    registerDeps({getPaymentByTrip});
    const onSettled = jest.fn();
    const onDeferred = jest.fn();
    const onFinish = jest.fn();

    const renderer = render(
      <SettlementBody
        tripId="trip-1"
        onSettled={onSettled}
        onDeferred={onDeferred}
        onFinish={onFinish}
        canFinish
      />,
    );
    await flush();

    const out = texts(renderer);
    expect(out).toContain('Completa tu pago');
    expect(out).toContain('Pagar después');

    await pressByLabel(renderer, 'Pagar después');
    // La salida DEBE cerrar el post-viaje (onFinish → closeTrip → passengerClosedAt): con onDeferred
    // la rehidratación re-adoptaría el settlement y volvería a atrapar al pasajero en este sheet.
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onDeferred).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('CIP (PagoEfectivo): hint honesto "cuando quieras + te lo recordamos", NO "se actualiza sola"', async () => {
    const getPaymentByTrip = jest.fn().mockResolvedValue(
      paymentView({method: 'PAGOEFECTIVO', cip: '12345678901234'}),
    );
    registerDeps({getPaymentByTrip});

    const renderer = render(
      <SettlementBody
        tripId="trip-1"
        onSettled={() => {}}
        onDeferred={() => {}}
        onFinish={() => {}}
        canFinish
      />,
    );
    await flush();

    const out = texts(renderer);
    expect(out).toContain(i18n.t('settlement.checkout.waitingHintCip'));
    expect(out).not.toContain(i18n.t('settlement.checkout.waitingHint'));
    // La salida "Pagar después" también está en la rama CIP (es el caso que la motiva).
    expect(out).toContain('Pagar después');

    act(() => renderer.unmount());
  });

  it('Yape/checkout de minutos: conserva el hint genérico "se actualiza sola"', async () => {
    const getPaymentByTrip = jest
      .fn()
      .mockResolvedValue(paymentView({deepLink: 'yapeapp:oneshot/abc'}));
    registerDeps({getPaymentByTrip});

    const renderer = render(
      <SettlementBody
        tripId="trip-1"
        onSettled={() => {}}
        onDeferred={() => {}}
        onFinish={() => {}}
        canFinish
      />,
    );
    await flush();

    expect(texts(renderer)).toContain(
      i18n.t('settlement.checkout.waitingHint'),
    );

    act(() => renderer.unmount());
  });
});

describe('SettlementBody · propina con cobro que requiere checkout', () => {
  it('si el cobro del tip vuelve PENDING con checkout → muestra CheckoutInstructions (no lo descarta)', async () => {
    const getPaymentByTrip = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'CAPTURED'}));
    // El tip es un COBRO dedicado: vuelve PENDING con deepLink (Yape one-shot, sin afiliación on-file).
    const addTip = jest.fn().mockResolvedValue(
      paymentView({
        id: 'pay-tip',
        status: 'PENDING',
        tipCents: 200,
        deepLink: 'yapeapp:oneshot/tip',
      }),
    );
    registerDeps({getPaymentByTrip, addTip});

    const renderer = render(
      <SettlementBody
        tripId="trip-1"
        onSettled={() => {}}
        onDeferred={() => {}}
        onFinish={() => {}}
        canFinish
      />,
    );
    await flush();

    // Recibo CAPTURED con chips de propina → deja S/2.
    await pressByText(renderer, 'S/ 2.00');
    await flush();

    expect(addTip).toHaveBeenCalledWith('trip-1', 200);
    const out = texts(renderer);
    // El checkout del tip se MUESTRA (antes se descartaba y la propina moría FAILED en silencio).
    expect(out).toContain(i18n.t('tips.checkoutTitle'));
    expect(out).toContain('Pagar con Yape');

    act(() => renderer.unmount());
  });

  it('si el cobro del tip vuelve FAILED → banner honesto y chips destrabados para elegir de nuevo', async () => {
    const getPaymentByTrip = jest
      .fn()
      .mockResolvedValue(paymentView({status: 'CAPTURED'}));
    const addTip = jest.fn().mockResolvedValue(
      paymentView({id: 'pay-tip', status: 'FAILED', tipCents: 200}),
    );
    registerDeps({getPaymentByTrip, addTip});

    const renderer = render(
      <SettlementBody
        tripId="trip-1"
        onSettled={() => {}}
        onDeferred={() => {}}
        onFinish={() => {}}
        canFinish
      />,
    );
    await flush();

    await pressByText(renderer, 'S/ 2.00');
    await flush();

    expect(texts(renderer)).toContain(i18n.t('tips.failedTitle'));

    act(() => renderer.unmount());
  });
});

/**
 * Copy-contract de HONESTIDAD del settlement (es-PE): los textos no prometen caminos que el backend
 * prohíbe ni retienen al pasajero con promesas falsas. Si alguien "mejora" el copy de vuelta a la
 * mentira, este test lo caza. El tono (tuteo) lo vigila aparte el voseoGuard.
 */
describe('Copy-contract · settlement honesto', () => {
  it('cashBanner NO promete pago mixto (no existe pagar "la diferencia con Yape")', () => {
    const value = i18n.t('settlement.cashBanner').toLowerCase();
    expect(value).not.toContain('yape');
    expect(value).not.toContain('diferencia');
  });

  it('checkout vencido NO ofrece pagar en efectivo (el backend responde 422)', () => {
    const value = i18n.t('settlement.checkout.expiredBody').toLowerCase();
    expect(value).not.toContain('efectivo');
  });

  it('debtBody dice la verdad: la deuda BLOQUEA el próximo viaje (no "se regulariza sola")', () => {
    const value = i18n.t('settlement.debtBody').toLowerCase();
    expect(value).not.toContain('regularizaremos');
    expect(value).toContain('próximo viaje');
  });

  it('las claves nuevas del checkout resuelven a texto real', () => {
    for (const key of [
      'settlement.checkout.payLater',
      'settlement.checkout.waitingHintCip',
    ]) {
      const value = i18n.t(key);
      expect(typeof value).toBe('string');
      expect(value).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
