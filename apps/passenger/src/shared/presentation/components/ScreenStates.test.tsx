import { ThemeProvider } from '@veo/ui-kit';
import React from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import '../../../i18n';
import { ScreenStateFallback } from './ScreenStates';

// `useReducedMotion` (ui-kit) usa AccessibilityInfo; el preset de RN no lo implementa. Stubs seguros.
{
  const { AccessibilityInfo } = jest.requireActual('react-native');
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() });
}

const INITIAL_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <ThemeProvider>{node}</ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap((n) => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter((c): c is string => typeof c === 'string');
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('ScreenStateFallback · estado de carga/error sobre SafeScreen', () => {
  it('loading → pinta los skeletons de carga, NUNCA el error ni Reintentar', () => {
    const renderer = render(<ScreenStateFallback loading loadingLines={3} />);

    // El bloque de carga marca su contenedor como "Cargando" (anti-CLS, accesible).
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Cargando' }).length).toBeGreaterThan(0);
    // En modo carga JAMÁS aparece la acción de reintento (eso es del estado de error).
    expect(texts(renderer)).not.toContain('Reintentar');

    act(() => renderer.unmount());
  });

  it('error con mensaje + onRetry → muestra el mensaje y el botón Reintentar dispara el callback', () => {
    const onRetry = jest.fn();
    const renderer = render(
      <ScreenStateFallback errorMessage="No pudimos cargar tus métodos de pago. Inténtalo de nuevo." onRetry={onRetry} />,
    );

    const out = texts(renderer);
    expect(out).toContain('Algo salió mal'); // states.errorTitle
    expect(out).toContain('No pudimos cargar tus métodos de pago. Inténtalo de nuevo.');
    expect(out).toContain('Reintentar');

    const retryBtn = renderer.root
      .findAllByProps({ accessibilityRole: 'button' })
      .find((b) => b.props.onPress);
    act(() => retryBtn?.props.onPress());
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('error SIN onRetry → muestra el error pero NO ofrece Reintentar', () => {
    const renderer = render(<ScreenStateFallback />);

    const out = texts(renderer);
    expect(out).toContain('Algo salió mal');
    expect(out).not.toContain('Reintentar');

    act(() => renderer.unmount());
  });
});
