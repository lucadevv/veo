import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { DiProvider } from '../../../../../core/di/useDi';
import type { AppContainer } from '../../../../../core/di/container';
import { useSessionStore } from '../../../../../core/session/sessionStore';
import { useLogin } from '../useAuth';

// MMKV nativo no existe en Jest: el store de sesión escribe en el almacén seguro al setear tokens.
// Stubeamos el módulo de storage para que las acciones del store no revienten al persistir.
jest.mock('../../../../../core/storage/mmkv', () => ({
  secureStore: {
    getString: () => null,
    getObject: () => null,
    setString: () => undefined,
    setObject: () => undefined,
    remove: () => undefined,
  },
  prefsStore: {
    getString: () => null,
    getObject: () => null,
    setString: () => undefined,
    setObject: () => undefined,
    remove: () => undefined,
  },
}));

// react-query difiere las notificaciones de estado a un setTimeout(0) (notifyManager). En Jest ese
// timer queda pendiente al cerrar el test y dispara post-teardown ("Cannot log after tests are done"),
// haciendo salir el run non-zero con todos los tests verdes. Notificar en SINCRÓNICO mantiene los
// re-renders dentro del act() de cada test y no deja timers colgando.
notifyManager.setScheduler((cb) => cb());

const TOKENS = { accessToken: 'acc-123', refreshToken: 'ref-456' };

/** Repo de perfil espía: registra si `getMe` fue invocado (NO debe pasar durante el login). */
function makeProfileSpy() {
  const getMe = jest.fn(() =>
    // Si el login lo llamara con un conductor nuevo, esto es un 404 que ANTES rompía el login.
    Promise.reject(
      new ApiError(404, 'NOT_FOUND', 'No existe un perfil de conductor para este usuario'),
    ),
  );
  return { getMe, onboard: jest.fn() };
}

/** Contenedor de prueba mínimo: solo lo que `useLogin` toca (auth, profile, localAuth). */
function makeContainer(profileSpy: ReturnType<typeof makeProfileSpy>): AppContainer {
  return {
    repositories: {
      auth: { verifyOtp: jest.fn(() => Promise.resolve(TOKENS)) },
      profile: profileSpy,
    },
    localAuth: {
      isAvailable: jest.fn(() => Promise.resolve(true)),
      saveRefreshToken: jest.fn(() => Promise.resolve()),
    },
  } as unknown as AppContainer;
}

/** Probe: expone la mutación de login para dispararla desde el test. */
function LoginProbe({ onReady }: { onReady: (login: ReturnType<typeof useLogin>) => void }) {
  const login = useLogin();
  onReady(login);
  return null;
}

function withProviders(node: ReactElement, client: QueryClient, container: AppContainer) {
  return (
    <QueryClientProvider client={client}>
      <DiProvider container={container}>{node}</DiProvider>
    </QueryClientProvider>
  );
}

describe('useLogin · no fetchea el perfil (el gate maneja el 404 → wizard)', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let client: QueryClient;

  beforeEach(() => {
    useSessionStore.setState({
      status: 'unauthenticated',
      accessToken: null,
      refreshToken: null,
      user: null,
      expired: false,
    });
  });

  afterEach(() => {
    // Desmontar el probe al cerrar cada test: sin esto los observers de la mutación quedan vivos
    // entre tests del mismo worker. El GC de la mutación que agenda el unmount expira al toque
    // gracias al gcTime: 0 del client (ver abajo).
    act(() => renderer?.unmount());
    renderer = undefined;
    client.clear();
  });

  it('tras verificar el OTP: setea tokens + authenticated y NO llama a GetProfileUseCase', async () => {
    const profileSpy = makeProfileSpy();
    const container = makeContainer(profileSpy);
    // gcTime 0: al desmontar, el GC de la mutación se agenda con setTimeout(gcTime); el default de
    // 5 min queda como timer vivo que impide salir a Jest (MutationCache.clear() NO lo cancela).
    client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
    let login!: ReturnType<typeof useLogin>;

    await act(async () => {
      renderer = TestRenderer.create(
        withProviders(<LoginProbe onReady={(l) => (login = l)} />, client, container),
      );
    });

    await act(async () => {
      await login.mutateAsync({ phone: '+51987654321', code: '123456' });
    });

    // El perfil NO se consulta en el login: un 404 de conductor nuevo es imposible de surfacear
    // como error de login (ese camino ya no existe).
    expect(profileSpy.getMe).not.toHaveBeenCalled();

    const session = useSessionStore.getState();
    expect(session.status).toBe('authenticated');
    expect(session.accessToken).toBe(TOKENS.accessToken);
    expect(session.refreshToken).toBe(TOKENS.refreshToken);
    // El `user` lo compone el gate, no el login.
    expect(session.user).toBeNull();
  });

  it('preserva el guardado best-effort del refresh token bajo biometría', async () => {
    const profileSpy = makeProfileSpy();
    const container = makeContainer(profileSpy);
    // gcTime 0: al desmontar, el GC de la mutación se agenda con setTimeout(gcTime); el default de
    // 5 min queda como timer vivo que impide salir a Jest (MutationCache.clear() NO lo cancela).
    client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
    let login!: ReturnType<typeof useLogin>;

    await act(async () => {
      renderer = TestRenderer.create(
        withProviders(<LoginProbe onReady={(l) => (login = l)} />, client, container),
      );
    });

    await act(async () => {
      await login.mutateAsync({ phone: '+51987654321', code: '123456' });
    });

    expect(container.localAuth.isAvailable).toHaveBeenCalled();
    expect(container.localAuth.saveRefreshToken).toHaveBeenCalledWith(TOKENS.refreshToken);
  });
});
