import type {PanicTriggerResult} from '@veo/api-client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';
import i18n from '../../../../i18n';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import type {RootStackParamList} from '../../../../navigation/types';
import type {TriggerPanicUseCase} from '../../domain/usecases';

// `useReducedMotion` (ui-kit) usa AccessibilityInfo; el preset de RN no lo implementa. Stub seguros.
{
  const {AccessibilityInfo} = jest.requireActual('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({remove: jest.fn()});
}

/** Params de la ruta `Panic` del test ACTIVO (mutable: cada test fija los suyos antes de render). */
let mockRouteParams: RootStackParamList['Panic'] = {tripId: 'trip-1'};
const mockGoBack = jest.fn();

// La pantalla lee navegación/ruta por hooks; acá no montamos un NavigationContainer real
// (la unidad bajo test es la PANTALLA, no el navigator): stub de useRoute/useNavigation.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => ({goBack: mockGoBack}),
    useRoute: () => ({
      key: 'Panic-test',
      name: 'Panic',
      params: mockRouteParams,
    }),
  };
});

import {PanicScreen} from './PanicScreen';

const INITIAL_METRICS = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

const RESULT: PanicTriggerResult = {
  panicId: 'panic-1',
  deduplicated: false,
} as PanicTriggerResult;

/** Doble del use case: solo `execute`, que es lo único que toca la pantalla. */
function registerTrigger(execute: jest.Mock): void {
  container.register(
    TOKENS.triggerPanicUseCase,
    () => ({execute}) as unknown as TriggerPanicUseCase,
  );
}

let activeClient: QueryClient | null = null;

function render(): TestRenderer.ReactTestRenderer {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  activeClient = client;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <PanicScreen />
          </ThemeProvider>
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

/** Textos planos en pantalla (los banners/títulos renderizan strings hoja). */
function hasText(
  renderer: TestRenderer.ReactTestRenderer,
  needle: string,
): boolean {
  return (
    renderer.root.findAll(n => {
      const c = n.props?.children;
      return typeof c === 'string' && c.includes(needle);
    }).length > 0
  );
}

/** El CTA de pánico del footer ("Enviar alerta"). Filtrado por su label accesible (rol button). */
function triggerButton(renderer: TestRenderer.ReactTestRenderer) {
  const label = i18n.t('panic.trigger');
  return renderer.root
    .findAllByProps({accessibilityRole: 'button'})
    .find(
      b =>
        b.props.accessibilityLabel === label &&
        typeof b.props.onPress === 'function',
    );
}

beforeEach(() => {
  container.reset();
  mockRouteParams = {tripId: 'trip-1'};
});

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
});

describe('PanicScreen · llegada por ESCALAMIENTO del disparo silencioso fallido', () => {
  it('con escalated: true arranca diciendo la verdad (banner de alerta fallida) con el CTA listo', async () => {
    mockRouteParams = {tripId: 'trip-1', escalated: true};
    registerTrigger(jest.fn().mockResolvedValue(RESULT));
    const renderer = render();
    await flush();

    // El banner de urgencia es visible SIN ningún intento manual previo.
    expect(hasText(renderer, i18n.t('panic.escalatedTitle'))).toBe(true);
    expect(hasText(renderer, i18n.t('panic.escalatedBody'))).toBe(true);
    // El CTA de pánico sigue siendo el protagonista: presente y habilitado para reintentar ya.
    expect(triggerButton(renderer)?.props.disabled).toBe(false);

    act(() => renderer.unmount());
  });

  it('sin escalated (acceso manual) conserva el estado neutro: ningún banner de fallo al montar', async () => {
    registerTrigger(jest.fn().mockResolvedValue(RESULT));
    const renderer = render();
    await flush();

    expect(hasText(renderer, i18n.t('panic.escalatedTitle'))).toBe(false);
    expect(hasText(renderer, i18n.t('panic.errorGeneric'))).toBe(false);
    expect(hasText(renderer, i18n.t('panic.title'))).toBe(true);

    act(() => renderer.unmount());
  });

  it('escalated + reintento manual fallido: el error del intento reemplaza al banner de escalamiento', async () => {
    mockRouteParams = {tripId: 'trip-1', escalated: true};
    registerTrigger(jest.fn().mockRejectedValue(new Error('boom')));
    const renderer = render();
    await flush();

    await act(async () => {
      triggerButton(renderer)?.props.onPress();
      await Promise.resolve();
    });
    await flush();

    // Un solo banner a la vez: el del intento RECIENTE (más específico) gana.
    expect(hasText(renderer, i18n.t('panic.errorGeneric'))).toBe(true);
    expect(hasText(renderer, i18n.t('panic.escalatedTitle'))).toBe(false);

    act(() => renderer.unmount());
  });

  it('escalated + reintento manual exitoso: confirma la alerta (pantalla de éxito con su ID)', async () => {
    mockRouteParams = {tripId: 'trip-1', escalated: true};
    const execute = jest.fn().mockResolvedValue(RESULT);
    registerTrigger(execute);
    const renderer = render();
    await flush();

    await act(async () => {
      triggerButton(renderer)?.props.onPress();
      await Promise.resolve();
    });
    await flush();

    expect(execute).toHaveBeenCalledWith('trip-1');
    expect(hasText(renderer, i18n.t('panic.sentTitle'))).toBe(true);
    expect(hasText(renderer, RESULT.panicId)).toBe(true);

    act(() => renderer.unmount());
  });
});
