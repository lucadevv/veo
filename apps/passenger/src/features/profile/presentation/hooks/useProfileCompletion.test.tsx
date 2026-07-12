import type {PassengerProfile} from '@veo/api-client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {useProfileLocalStore} from '../../../auth/presentation';
import type {GetProfileUseCase} from '../../domain/usecases';
import {
  useProfileCompletion,
  type ProfileCompletion,
} from './useProfileCompletion';

/**
 * Especificación de la REGLA DE COMPLETITUD nueva: el perfil está completo SOLO con `name` real. El
 * correo no alcanza, y la bandera local MMKV NUNCA saltea el chequeo del nombre. Cubre el bug que el
 * dueño reportó: usuarios sin nombre (alta por OTP/Google/Apple) deben ver `CompleteProfileScreen`.
 */

const USER_ID = 'u1';

function makeProfile(overrides: Partial<PassengerProfile>): PassengerProfile {
  return {
    id: USER_ID,
    name: null,
    email: null,
    phone: null,
    photoUrl: null,
    kycStatus: 'NONE',
    documentType: null,
    document: null,
    ...overrides,
  } as PassengerProfile;
}

/** Registra el doble del `GetProfileUseCase` que el hook resuelve por DI. */
function registerProfile(profile: PassengerProfile | Error): void {
  container.register(
    TOKENS.getProfileUseCase,
    () =>
      ({
        execute:
          profile instanceof Error
            ? jest.fn().mockRejectedValue(profile)
            : jest.fn().mockResolvedValue(profile),
      }) as unknown as GetProfileUseCase,
  );
}

/** Prepara la sesión como autenticada (condición `active` del hook). */
function authenticate(): void {
  useSessionStore.setState({
    user: {id: USER_ID} as never,
    status: 'authenticated',
  });
}

let activeClient: QueryClient | null = null;

/** Monta el hook en una sonda y devuelve un getter del último valor derivado. */
function renderHook(): {
  current: () => ProfileCompletion;
  unmount: () => void;
} {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  activeClient = client;
  let last: ProfileCompletion = 'loading';
  function Probe(): null {
    last = useProfileCompletion();
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
  useProfileLocalStore.setState({completedByUser: {}});
});

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  useSessionStore.setState({user: null, status: 'unknown'} as never);
  useProfileLocalStore.setState({completedByUser: {}});
  jest.clearAllMocks();
});

describe('useProfileCompletion · regla = nombre presente', () => {
  it('sin sesión activa → loading', () => {
    registerProfile(makeProfile({}));
    const hook = renderHook();
    expect(hook.current()).toBe('loading');
    hook.unmount();
  });

  it('perfil con nombre → complete', async () => {
    authenticate();
    registerProfile(makeProfile({name: 'María Ríos'}));
    const hook = renderHook();
    await flush();
    expect(hook.current()).toBe('complete');
    hook.unmount();
  });

  it('perfil SIN nombre pero CON correo → incomplete (el correo no alcanza)', async () => {
    authenticate();
    registerProfile(makeProfile({name: null, email: 'ana@correo.com'}));
    const hook = renderHook();
    await flush();
    expect(hook.current()).toBe('incomplete');
    hook.unmount();
  });

  it('perfil con nombre solo espacios en blanco → incomplete (name vacío real)', async () => {
    authenticate();
    registerProfile(makeProfile({name: '   '}));
    const hook = renderHook();
    await flush();
    expect(hook.current()).toBe('incomplete');
    hook.unmount();
  });

  it('bandera local marcada NO saltea el nombre: perfil cargado sin nombre → incomplete', async () => {
    authenticate();
    // El usuario quedó marcado localmente, pero el perfil REAL no tiene nombre (el bug del dueño).
    useProfileLocalStore.setState({completedByUser: {[USER_ID]: true}});
    registerProfile(makeProfile({name: null, email: 'x@y.com'}));
    const hook = renderHook();
    await flush();
    expect(hook.current()).toBe('incomplete');
    hook.unmount();
  });

  it('error de red sin datos → complete (fail-open: no bloquear la app)', async () => {
    authenticate();
    registerProfile(new Error('network'));
    const hook = renderHook();
    await flush();
    expect(hook.current()).toBe('complete');
    hook.unmount();
  });
});
