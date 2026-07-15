import React, { type ReactElement } from 'react';
import { AccessibilityInfo, Image } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import '../../../../../i18n';
import { Button, Text } from '@veo/ui-kit';
import { OnboardingScreen } from '../OnboardingScreen';

/**
 * drv-02 · Onboarding de intro (rediseño Tesla con foto real). Verifica la COMPOSICIÓN y la lógica
 * del carrusel: (1) renderiza los títulos de los 3 slides + una foto a sangre por slide; (2) hay UN
 * solo CTA primario por vista (accent) y el label avanza "Siguiente" → "Crear cuenta" recién en el
 * último; (3) el CTA en el último slide completa; (4) "Omitir" (texto plano, variant ghost)
 * completa. `complete` es el efecto observable hacia el RootNavigator.
 */

const mockComplete = jest.fn();

jest.mock('../../state/onboardingStore', () => ({
  useOnboardingStore: (selector: (s: { complete: () => void }) => unknown) =>
    selector({ complete: mockComplete }),
}));

// Onboarding es la primera vista: forzamos reduce-motion para un render determinista (sin timers).
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockReturnValue({ remove: () => undefined } as ReturnType<
    typeof AccessibilityInfo.addEventListener
  >);

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function withProviders(node: ReactElement): React.JSX.Element {
  return <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{node}</SafeAreaProvider>;
}

/** El CTA primario único: el Button con variant 'accent' (cyan sólido). */
function primaryCta(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(Button).filter((b) => b.props.variant === 'accent');
}

/** El secundario "Omitir": texto plano (variant 'ghost'), sin caja. */
function skipButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Button)
    .find((b) => b.props.variant === 'ghost' && b.props.label === 'Omitir');
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((c): c is string => typeof c === 'string');
}

describe('OnboardingScreen · drv-02 rediseño Tesla (foto real)', () => {
  beforeEach(() => {
    mockComplete.mockClear();
  });

  it('renderiza los títulos de los tres slides del carrusel', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<OnboardingScreen />));
    });

    const allText = texts(renderer);
    expect(allText).toContain('Maneja a tu manera');
    expect(allText).toContain('Tú pones el precio');
    expect(allText).toContain('Maneja protegido');

    act(() => renderer.unmount());
  });

  it('cada slide trae su foto a sangre (una Image por slide)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<OnboardingScreen />));
    });

    const photos = renderer.root.findAllByType(Image);
    expect(photos).toHaveLength(3);

    act(() => renderer.unmount());
  });

  it('hay UN solo CTA primario (accent) y arranca con label "Siguiente"', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<OnboardingScreen />));
    });

    const cta = primaryCta(renderer);
    expect(cta).toHaveLength(1);
    expect(cta[0]!.props.label).toBe('Siguiente');
    expect(cta[0]!.props.fullWidth).toBe(true);

    act(() => renderer.unmount());
  });

  it('el CTA avanza por los 3 slides (label pasa a "Crear cuenta" en el último) y luego completa', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<OnboardingScreen />));
    });

    // Primer press: avanza del slide 0 al 1 (intermedio). Sigue "Siguiente", no completa.
    act(() => {
      (primaryCta(renderer)[0]!.props.onPress as () => void)();
    });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(primaryCta(renderer)[0]!.props.label).toBe('Siguiente');

    // Segundo press: avanza del slide 1 al 2 (último). Label pasa a "Crear cuenta", aún no completa.
    act(() => {
      (primaryCta(renderer)[0]!.props.onPress as () => void)();
    });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(primaryCta(renderer)[0]!.props.label).toBe('Crear cuenta');

    // Tercer press en el último slide: completa (RootNavigator conmuta al Login).
    act(() => {
      (primaryCta(renderer)[0]!.props.onPress as () => void)();
    });
    expect(mockComplete).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('"Omitir" (texto plano, ghost) completa el onboarding sin avanzar', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<OnboardingScreen />));
    });

    const skip = skipButton(renderer);
    expect(skip).toBeDefined();

    act(() => {
      (skip!.props.onPress as () => void)();
    });
    expect(mockComplete).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });
});
