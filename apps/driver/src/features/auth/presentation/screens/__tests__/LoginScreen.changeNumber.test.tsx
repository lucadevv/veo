import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import '../../../../../i18n';
import { Button, IconButton, TextField } from '@veo/ui-kit';
import { LoginScreen } from '../LoginScreen';

/**
 * U2 · dedup (DUP #1): en el paso CÓDIGO del login, "cambiar número" tiene UNA sola affordance — el chevron
 * back de arriba (IconButton, gesto idiomático del OTP). El Button ghost "Cambiar número" del bloque inferior
 * (que ejecutaba el MISMO handler: `setStep('phone'); setCode('')`) fue ELIMINADO. Este test verifica que en
 * el paso código NO existe ningún Button con label "Cambiar número", y que el chevron conserva su
 * `accessibilityLabel` "Cambiar número" (la affordance accesible de volver).
 */

// `useRequestOtp` mockeado: `mutate(phone, { onSuccess })` invoca `onSuccess` de inmediato → la pantalla
// pasa al paso 'code' sin red. `useLogin`/`useBiometricRelogin` se neutralizan (no se ejercitan acá).
jest.mock('../../hooks/useAuth', () => ({
  useRequestOtp: () => ({
    mutate: (_phone: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useLogin: () => ({ mutate: jest.fn(), isPending: false, isError: false, error: null }),
}));

jest.mock('../../hooks/useBiometricRelogin', () => ({
  useBiometricRelogin: () => ({
    available: false,
    isPending: false,
    error: null,
    relogin: () => Promise.resolve(),
  }),
}));

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

function withProviders(node: ReactElement, client: QueryClient): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Avanza la pantalla del paso teléfono al paso código: tipea un teléfono válido y dispara "Enviar código". */
function goToCodeStep(renderer: TestRenderer.ReactTestRenderer): void {
  const phoneField = renderer.root.findByType(TextField);
  act(() => {
    (phoneField.props.onChangeText as (t: string) => void)('987654321');
  });
  const requestButton = renderer.root
    .findAllByType(Button)
    .find((b) => b.props.label === 'Enviar código');
  act(() => {
    (requestButton!.props.onPress as () => void)();
  });
}

describe('LoginScreen · U2 dedup (DUP #1): "cambiar número" tiene una sola affordance (el chevron)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('en el paso CÓDIGO: NO hay Button "Cambiar número"; el chevron conserva su accessibilityLabel', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<LoginScreen />, queryClient));
    });

    goToCodeStep(renderer);

    // El Button ghost "Cambiar número" fue eliminado: 0 Buttons con ese label en el paso código.
    const changeNumberButtons = renderer.root
      .findAllByType(Button)
      .filter((b) => b.props.label === 'Cambiar número');
    expect(changeNumberButtons).toHaveLength(0);

    // El chevron back (IconButton) sigue siendo la affordance de volver, con su a11y label intacto.
    const chevron = renderer.root
      .findAllByType(IconButton)
      .find((b) => b.props.accessibilityLabel === 'Cambiar número');
    expect(chevron).toBeDefined();
    expect(typeof chevron?.props.onPress).toBe('function');

    act(() => {
      renderer.unmount();
    });
  });
});
