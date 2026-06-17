import type {YapeAffiliationView} from '@veo/api-client';
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
import type {GetYapeAffiliationUseCase} from '../../domain/affiliationUsecases';
import {PaymentMethodsScreen} from './PaymentMethodsScreen';

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

/** Registra el caso de uso de lectura de afiliación con la implementación (mock) dada. */
function registerAffiliation(getAffiliation: jest.Mock): void {
  container.register(
    TOKENS.getYapeAffiliationUseCase,
    () => ({execute: getAffiliation}) as unknown as GetYapeAffiliationUseCase,
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

function affiliationView(
  over?: Partial<YapeAffiliationView>,
): YapeAffiliationView {
  return {status: 'NONE', ...over} as YapeAffiliationView;
}

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
  container.reset();
});

describe('PaymentMethodsScreen · 4 estados de la afiliación Yape (degradación honesta)', () => {
  it('ERROR de red → estado de error + Reintentar; NUNCA muestra "Vincular" (no confunde error con "no afiliado")', async () => {
    const getAffiliation = jest
      .fn()
      .mockRejectedValue(new Error('network down'));
    registerAffiliation(getAffiliation);

    const renderer = render(<PaymentMethodsScreen />);
    await flush();

    const out = texts(renderer);
    // Estado de error honesto + acción de reintento.
    expect(out).toContain('Algo salió mal');
    expect(out).toContain(
      'No pudimos cargar tus métodos de pago. Inténtalo de nuevo.',
    );
    expect(out).toContain('Reintentar');
    // EL HALLAZGO: ante fallo de red JAMÁS se ofrece "Vincular" (eso fingiría que perdió su Yape).
    expect(out).not.toContain('Vincular');

    act(() => renderer.unmount());
  });

  it('Reintentar vuelve a consultar la afiliación (refetch real)', async () => {
    const getAffiliation = jest
      .fn()
      .mockRejectedValue(new Error('network down'));
    registerAffiliation(getAffiliation);

    const renderer = render(<PaymentMethodsScreen />);
    await flush();
    expect(getAffiliation).toHaveBeenCalledTimes(1);

    const retry = renderer.root
      .findAllByProps({accessibilityRole: 'button'})
      .find(
        b =>
          b.props.accessibilityLabel === 'Reintentar' ||
          b.props.children === 'Reintentar',
      );
    // El botón de reintento existe y dispara un nuevo fetch.
    const retryBtn =
      retry ??
      renderer.root
        .findAllByProps({accessibilityRole: 'button'})
        .find(b => b.props.onPress);
    await act(async () => {
      retryBtn?.props.onPress();
      await Promise.resolve();
    });
    await flush();

    expect(getAffiliation.mock.calls.length).toBeGreaterThanOrEqual(2);
    act(() => renderer.unmount());
  });

  it('SUCCESS status NONE (genuinamente sin afiliar) → SÍ muestra "Vincular"', async () => {
    const getAffiliation = jest
      .fn()
      .mockResolvedValue(affiliationView({status: 'NONE'}));
    registerAffiliation(getAffiliation);

    const renderer = render(<PaymentMethodsScreen />);
    await flush();

    expect(texts(renderer)).toContain('Vincular');
    act(() => renderer.unmount());
  });

  it('SUCCESS status ACTIVE → fila Yape vinculada (sin "Vincular"), con su teléfono enmascarado', async () => {
    const getAffiliation = jest
      .fn()
      .mockResolvedValue(
        affiliationView({status: 'ACTIVE', phoneMasked: '••• 678'}),
      );
    registerAffiliation(getAffiliation);

    const renderer = render(<PaymentMethodsScreen />);
    await flush();

    const out = texts(renderer);
    expect(out).not.toContain('Vincular');
    expect(out.some(s => s.includes('••• 678'))).toBe(true);
    act(() => renderer.unmount());
  });
});
