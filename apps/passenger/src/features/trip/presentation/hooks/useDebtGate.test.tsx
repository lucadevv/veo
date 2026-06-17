import type {DebtItemView, DebtView} from '@veo/api-client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import type {GetMyDebtsUseCase} from '../../../payments/domain/usecases';
import {useDebtGate, type DebtGateController} from './useDebtGate';

/**
 * Especificación de la MÁQUINA del gate de deuda (BR-P02, plata): los dos orígenes del sheet
 * (pedido bloqueado 403 vs franja del home), la prioridad deuda > pago por completar, el
 * `requestAgainToken` que re-dispara el pedido SOLO si el sheet vino de un pedido bloqueado, y
 * `hasDebt` tomado CRUDO del server (la app no re-deriva el gate: el gate es server-side).
 */

// `useMyDebts` refetchea al recuperar foco (useFocusEffect): acá la unidad es la máquina del gate,
// no la navegación → stub no-op (sin montar un NavigationContainer real).
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {...actual, useFocusEffect: jest.fn()};
});

/** Ítem accionable del wire. Por defecto una DEUDA real; cada caso pisa lo suyo. */
function makeItem(overrides: Partial<DebtItemView> = {}): DebtItemView {
  return {
    paymentId: 'pay-1',
    tripId: 'trip-1',
    amountCents: 1500,
    reason: 'declined',
    createdAt: '2026-06-01T10:00:00.000Z',
    kind: 'DEBT',
    ...overrides,
  };
}

function makeDebtView(overrides: Partial<DebtView> = {}): DebtView {
  return {hasDebt: false, totalCents: 0, debts: [], ...overrides};
}

/** Registra el doble del `GetMyDebtsUseCase` que `useMyDebts` resuelve por DI. */
function registerDebts(view: DebtView): void {
  container.register(
    TOKENS.getMyDebtsUseCase,
    () =>
      ({
        execute: jest.fn().mockResolvedValue(view),
      }) as unknown as GetMyDebtsUseCase,
  );
}

let activeClient: QueryClient | null = null;

/** Monta el hook en una sonda y devuelve un getter del último controller. */
function renderGate(enabled = true): {
  current: () => DebtGateController;
  unmount: () => void;
} {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  activeClient = client;
  let last!: DebtGateController;
  function Probe(): null {
    last = useDebtGate(enabled);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return {
    current: () => last,
    unmount: () => act(() => renderer.unmount()),
  };
}

/** Deja correr la query (macrotasks reales de react-query) y su re-render. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  container.reset();
});

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
});

describe('useDebtGate · hasDebt crudo del server', () => {
  it('refleja hasDebt/totalCents tal como llegan (sin re-derivar de los ítems)', async () => {
    // Caso adrede "incoherente": hasDebt=false con un ítem DEBT en la lista. El gate es SERVER-SIDE:
    // si la app re-derivara de los ítems, divergiría del 403 real del BFF.
    registerDebts(
      makeDebtView({hasDebt: false, totalCents: 0, debts: [makeItem()]}),
    );
    const gate = renderGate();
    await flush();
    expect(gate.current().hasDebt).toBe(false);
    expect(gate.current().debtTotalCents).toBe(0);
    gate.unmount();
  });

  it('con deuda real: hasDebt true + total para la franja + debtView para el sheet', async () => {
    const view = makeDebtView({
      hasDebt: true,
      totalCents: 1500,
      debts: [makeItem()],
    });
    registerDebts(view);
    const gate = renderGate();
    await flush();
    expect(gate.current().hasDebt).toBe(true);
    expect(gate.current().debtTotalCents).toBe(1500);
    expect(gate.current().debtView).toEqual(view);
    gate.unmount();
  });
});

describe('useDebtGate · prioridad deuda > pago por completar', () => {
  it('PENDING_ACTION sin deuda → hasPendingAction true', async () => {
    registerDebts(
      makeDebtView({
        debts: [
          makeItem({kind: 'PENDING_ACTION', reason: '', paymentId: 'pay-9'}),
        ],
      }),
    );
    const gate = renderGate();
    await flush();
    expect(gate.current().hasPendingAction).toBe(true);
    expect(gate.current().hasDebt).toBe(false);
    gate.unmount();
  });

  it('con deuda real, el PENDING_ACTION se calla (la deuda es lo urgente)', async () => {
    registerDebts(
      makeDebtView({
        hasDebt: true,
        totalCents: 1500,
        debts: [
          makeItem(),
          makeItem({kind: 'PENDING_ACTION', reason: '', paymentId: 'pay-9'}),
        ],
      }),
    );
    const gate = renderGate();
    await flush();
    expect(gate.current().hasDebt).toBe(true);
    expect(gate.current().hasPendingAction).toBe(false);
    gate.unmount();
  });
});

describe('useDebtGate · los dos orígenes del sheet', () => {
  it('origen PEDIDO BLOQUEADO (403): abre en modo deuda y, tras saldar, re-dispara el pedido', async () => {
    registerDebts(
      makeDebtView({hasDebt: true, totalCents: 1500, debts: [makeItem()]}),
    );
    const gate = renderGate();
    await flush();

    act(() => gate.current().onDebtPending());
    expect(gate.current().debtSheetOpen).toBe(true);
    expect(gate.current().pendingActionPaymentId).toBeNull();
    expect(gate.current().requestAgainToken).toBe(0);

    act(() => gate.current().onDebtSettled());
    expect(gate.current().debtSheetOpen).toBe(false);
    // La señal que QuotingBody observa: saldó una deuda que BLOQUEABA un pedido → reintentar solo.
    expect(gate.current().requestAgainToken).toBe(1);
    gate.unmount();
  });

  it('origen FRANJA DEL HOME: abre en modo deuda y, tras saldar, NO re-dispara ningún pedido', async () => {
    registerDebts(
      makeDebtView({hasDebt: true, totalCents: 1500, debts: [makeItem()]}),
    );
    const gate = renderGate();
    await flush();

    act(() => gate.current().openDebtFromHome());
    expect(gate.current().debtSheetOpen).toBe(true);
    expect(gate.current().pendingActionPaymentId).toBeNull();

    act(() => gate.current().onDebtSettled());
    expect(gate.current().debtSheetOpen).toBe(false);
    expect(gate.current().requestAgainToken).toBe(0);
    gate.unmount();
  });

  it('origen FRANJA (pago por completar): abre en modo PENDING_ACTION con el id del 1er pendiente', async () => {
    registerDebts(
      makeDebtView({
        debts: [
          makeItem({kind: 'PENDING_ACTION', reason: '', paymentId: 'pay-9'}),
          makeItem({kind: 'PENDING_ACTION', reason: '', paymentId: 'pay-10'}),
        ],
      }),
    );
    const gate = renderGate();
    await flush();

    act(() => gate.current().openPendingFromHome());
    expect(gate.current().debtSheetOpen).toBe(true);
    expect(gate.current().pendingActionPaymentId).toBe('pay-9');

    // Al completar/cerrar, el modo PENDING_ACTION se limpia (no se arrastra a la próxima apertura).
    act(() => gate.current().onDebtSettled());
    expect(gate.current().pendingActionPaymentId).toBeNull();
    expect(gate.current().requestAgainToken).toBe(0);
    gate.unmount();
  });

  it('sin pendiente cargado, openPendingFromHome es no-op (la franja no debería ofrecerlo)', async () => {
    registerDebts(makeDebtView());
    const gate = renderGate();
    await flush();
    act(() => gate.current().openPendingFromHome());
    expect(gate.current().debtSheetOpen).toBe(false);
    gate.unmount();
  });
});

describe('useDebtGate · requestAgainToken re-dispara tras CADA deuda saldada de un pedido', () => {
  it('cada ciclo 403 → saldar incrementa el token; saldar desde el home no', async () => {
    registerDebts(
      makeDebtView({hasDebt: true, totalCents: 1500, debts: [makeItem()]}),
    );
    const gate = renderGate();
    await flush();

    act(() => gate.current().onDebtPending());
    act(() => gate.current().onDebtSettled());
    expect(gate.current().requestAgainToken).toBe(1);

    // Segundo pedido bloqueado (otra deuda): el token vuelve a moverse → QuotingBody re-dispara.
    act(() => gate.current().onDebtPending());
    act(() => gate.current().onDebtSettled());
    expect(gate.current().requestAgainToken).toBe(2);

    // El origen NO es pegajoso: tras saldar, un cierre desde el home ya no re-dispara nada.
    act(() => gate.current().openDebtFromHome());
    act(() => gate.current().onDebtSettled());
    expect(gate.current().requestAgainToken).toBe(2);
    gate.unmount();
  });

  it('cerrar el sheet sin saldar (closeDebtSheet) no toca el token ni el modo', async () => {
    registerDebts(
      makeDebtView({hasDebt: true, totalCents: 1500, debts: [makeItem()]}),
    );
    const gate = renderGate();
    await flush();

    act(() => gate.current().onDebtPending());
    act(() => gate.current().closeDebtSheet());
    expect(gate.current().debtSheetOpen).toBe(false);
    expect(gate.current().requestAgainToken).toBe(0);
    gate.unmount();
  });
});
