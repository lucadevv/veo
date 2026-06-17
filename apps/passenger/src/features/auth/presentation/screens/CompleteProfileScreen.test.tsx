import type {PassengerProfile} from '@veo/api-client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {TextInput} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';
import i18n from '../../../../i18n';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {useProfileLocalStore} from '../../../auth/presentation';
import type {
  GetProfileUseCase,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  RemoveAvatarUseCase,
} from '../../../profile/domain/usecases';
import type {ImagePickerService} from '../../../../shared/media/domain/imagePickerService';

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

import {CompleteProfileScreen} from './CompleteProfileScreen';

const USER_ID = 'u1';

const INITIAL_METRICS = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

function makeProfile(overrides: Partial<PassengerProfile>): PassengerProfile {
  return {
    id: USER_ID,
    name: null,
    email: null,
    phone: '+51999888777',
    photoUrl: null,
    kycStatus: 'NONE',
    documentType: null,
    document: null,
    ...overrides,
  } as PassengerProfile;
}

/** Registra los dobles de los usecases/servicios que la pantalla resuelve por DI. */
function registerDeps(profile: PassengerProfile, update = jest.fn()): void {
  container.register(
    TOKENS.getProfileUseCase,
    () =>
      ({
        execute: jest.fn().mockResolvedValue(profile),
      }) as unknown as GetProfileUseCase,
  );
  container.register(
    TOKENS.updateProfileUseCase,
    () => ({execute: update}) as unknown as UpdateProfileUseCase,
  );
  container.register(
    TOKENS.uploadAvatarUseCase,
    () => ({execute: jest.fn()}) as unknown as UploadAvatarUseCase,
  );
  container.register(
    TOKENS.removeAvatarUseCase,
    () => ({execute: jest.fn()}) as unknown as RemoveAvatarUseCase,
  );
  container.register(
    TOKENS.imagePickerService,
    () => ({pick: jest.fn()}) as unknown as ImagePickerService,
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
            <CompleteProfileScreen />
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

/** El botón del footer "Listo, empieza a viajar". Filtramos por su label accesible (rol button). */
function submitButton(renderer: TestRenderer.ReactTestRenderer) {
  const label = i18n.t('profileSetup.submit');
  return renderer.root
    .findAllByProps({accessibilityRole: 'button'})
    .find(
      b =>
        b.props.accessibilityLabel === label &&
        typeof b.props.onPress === 'function',
    );
}

/** Textos planos en pantalla (para verificar la fila de correo de solo lectura). */
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

/** El TextInput del NOMBRE: el primero (en orden de render el nombre va antes que el correo). */
function nameInput(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance {
  const input = renderer.root.findAllByType(TextInput)[0];
  if (!input) {
    throw new Error('No se encontró el campo de nombre');
  }
  return input;
}

beforeEach(() => {
  container.reset();
  useSessionStore.setState({
    user: {id: USER_ID} as never,
    status: 'authenticated',
  });
  useProfileLocalStore.setState({completedByUser: {}});
});

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  useSessionStore.setState({user: null, status: 'unknown'} as never);
  useProfileLocalStore.setState({completedByUser: {}});
  jest.clearAllMocks();
});

describe('CompleteProfileScreen · completitud del form (ÚNICO gate = nombre)', () => {
  it('caso Apple (correo ya entregado): el correo es una fila de solo lectura, NO un campo editable', async () => {
    registerDeps(makeProfile({email: 'ana@icloud.com'}));
    const renderer = render();
    await flush();

    // Microcopy + correo visibles como info, no como input.
    expect(hasText(renderer, 'ana@icloud.com')).toBe(true);
    expect(hasText(renderer, i18n.t('profileSetup.emailFromAccount'))).toBe(
      true,
    );
    // Solo hay UN TextInput (el del nombre); el correo NO es un TextField.
    expect(renderer.root.findAllByType(TextInput)).toHaveLength(1);

    act(() => renderer.unmount());
  });

  it('caso Apple: con correo prefilled y SIN documento, escribir el nombre habilita el submit al toque', async () => {
    const update = jest
      .fn()
      .mockResolvedValue(
        makeProfile({name: 'Ana Ríos', email: 'ana@icloud.com'}),
      );
    registerDeps(makeProfile({email: 'ana@icloud.com'}), update);
    const renderer = render();
    await flush();

    // Sin nombre → submit deshabilitado.
    expect(submitButton(renderer)?.props.disabled).toBe(true);

    // Escribe el nombre → submit habilitado (nada más que hacer).
    await act(async () => {
      nameInput(renderer).props.onChangeText('Ana Ríos');
    });
    expect(submitButton(renderer)?.props.disabled).toBe(false);

    // Al enviar NO se reenvía el correo ya persistido ni se manda documento.
    await act(async () => {
      submitButton(renderer)?.props.onPress();
      await Promise.resolve();
    });
    await flush();
    expect(update).toHaveBeenCalledWith({name: 'Ana Ríos'});

    act(() => renderer.unmount());
  });

  it('sin correo en el perfil: el correo es un campo editable (dos TextInputs: nombre + correo)', async () => {
    registerDeps(makeProfile({email: null}));
    const renderer = render();
    await flush();

    expect(renderer.root.findAllByType(TextInput)).toHaveLength(2);
    expect(hasText(renderer, i18n.t('profileSetup.emailFromAccount'))).toBe(
      false,
    );

    act(() => renderer.unmount());
  });

  it('sin correo: el nombre habilita el submit aunque el correo quede vacío (correo opcional)', async () => {
    const update = jest.fn().mockResolvedValue(makeProfile({name: 'Ana Ríos'}));
    registerDeps(makeProfile({email: null}), update);
    const renderer = render();
    await flush();

    expect(submitButton(renderer)?.props.disabled).toBe(true);
    await act(async () => {
      nameInput(renderer).props.onChangeText('Ana Ríos');
    });
    expect(submitButton(renderer)?.props.disabled).toBe(false);

    await act(async () => {
      submitButton(renderer)?.props.onPress();
      await Promise.resolve();
    });
    await flush();
    // Correo vacío → no se incluye en el PATCH.
    expect(update).toHaveBeenCalledWith({name: 'Ana Ríos'});

    act(() => renderer.unmount());
  });
});
