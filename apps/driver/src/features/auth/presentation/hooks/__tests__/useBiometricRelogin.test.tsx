import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DiProvider } from '../../../../../core/di/useDi';
import type { AppContainer } from '../../../../../core/di/container';
import { useSessionStore } from '../../../../../core/session/sessionStore';
import { useBiometricRelogin } from '../useBiometricRelogin';

// MMKV nativo no existe en Jest (igual que useLogin.test): stub del almacén seguro.
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

const TOKENS = { accessToken: 'acc-new', refreshToken: 'ref-new' };

interface Overrides {
  getMe?: jest.Mock;
  saveRefreshToken?: jest.Mock;
  unlockRefreshToken?: jest.Mock;
}

function makeContainer({ getMe, saveRefreshToken, unlockRefreshToken }: Overrides): AppContainer {
  return {
    repositories: {
      auth: { verifyOtp: jest.fn() },
      profile: { getMe: getMe ?? jest.fn(() => Promise.resolve({ id: 'd1' })), onboard: jest.fn() },
    },
    localAuth: {
      isAvailable: jest.fn(() => Promise.resolve(true)),
      hasStoredToken: jest.fn(() => Promise.resolve(true)),
      // Discriminado (DRIFT-1): ok con token por default; los tests overridean para cancelled/failed.
      unlockRefreshToken:
        unlockRefreshToken ?? jest.fn(() => Promise.resolve({ status: 'ok', token: 'ref-old' })),
      saveRefreshToken: saveRefreshToken ?? jest.fn(() => Promise.resolve()),
    },
  } as unknown as AppContainer;
}

function Probe({ onState }: { onState: (s: ReturnType<typeof useBiometricRelogin>) => void }) {
  const state = useBiometricRelogin();
  onState(state);
  return null;
}

function withProviders(node: ReactElement, container: AppContainer) {
  return <DiProvider container={container}>{node}</DiProvider>;
}

describe('useBiometricRelogin · orden de persistencia del Keychain (A3)', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    useSessionStore.setState({
      status: 'unauthenticated',
      accessToken: null,
      refreshToken: null,
      user: null,
      expired: false,
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => TOKENS } as unknown as Response),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('A3: si el fetch del PERFIL falla, el refresh token NUEVO igual quedó persistido en el Keychain', async () => {
    // El servidor YA rotó el jti al responder OK el /auth/refresh. El fetch del perfil (falible) falla.
    const getMe = jest.fn(() => Promise.reject(new Error('red flaky')));
    const saveRefreshToken = jest.fn(() => Promise.resolve());
    const container = makeContainer({ getMe, saveRefreshToken });
    let latest!: ReturnType<typeof useBiometricRelogin>;

    await act(async () => {
      TestRenderer.create(withProviders(<Probe onState={(s) => (latest = s)} />, container));
    });
    await act(async () => {
      await latest.relogin();
    });

    // El fix A3: saveRefreshToken corre ANTES del fetch del perfil → aunque el perfil falle, el Keychain YA
    // tiene el jti NUEVO (antes quedaba con el jti VIEJO ya rotado → reuse-detection → relogin brickeado).
    expect(saveRefreshToken).toHaveBeenCalledWith(TOKENS.refreshToken);
    expect(getMe).toHaveBeenCalled(); // el perfil se intentó (y falló)
    expect(latest.error).toBeInstanceOf(Error); // el error del perfil se surfacea, no se traga
  });

  it('camino feliz: rota tokens, persiste el Keychain y compone la sesión', async () => {
    const saveRefreshToken = jest.fn(() => Promise.resolve());
    const container = makeContainer({ saveRefreshToken });
    let latest!: ReturnType<typeof useBiometricRelogin>;

    await act(async () => {
      TestRenderer.create(withProviders(<Probe onState={(s) => (latest = s)} />, container));
    });
    await act(async () => {
      await latest.relogin();
    });

    expect(saveRefreshToken).toHaveBeenCalledWith(TOKENS.refreshToken);
    expect(latest.error).toBeNull();
    const session = useSessionStore.getState();
    expect(session.accessToken).toBe(TOKENS.accessToken);
    expect(session.refreshToken).toBe(TOKENS.refreshToken);
  });

  it('DRIFT-1: un FALLO biométrico real (status failed) → setError (banner), NO fetch', async () => {
    const unlockRefreshToken = jest.fn(() =>
      Promise.resolve({ status: 'failed', error: new Error('no match') }),
    );
    const container = makeContainer({ unlockRefreshToken });
    let latest!: ReturnType<typeof useBiometricRelogin>;

    await act(async () => {
      TestRenderer.create(withProviders(<Probe onState={(s) => (latest = s)} />, container));
    });
    await act(async () => {
      await latest.relogin();
    });

    // Fallo REAL → banner (error poblado) y NO se llega a llamar el /auth/refresh.
    expect(latest.error).toBeInstanceOf(Error);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('DRIFT-1: una CANCELACIÓN del usuario (status cancelled) → silencioso (sin banner, sin fetch)', async () => {
    const unlockRefreshToken = jest.fn(() => Promise.resolve({ status: 'cancelled' }));
    const container = makeContainer({ unlockRefreshToken });
    let latest!: ReturnType<typeof useBiometricRelogin>;

    await act(async () => {
      TestRenderer.create(withProviders(<Probe onState={(s) => (latest = s)} />, container));
    });
    await act(async () => {
      await latest.relogin();
    });

    // Cancelación → cae a OTP en silencio: sin error (banner) y sin pegarle al backend.
    expect(latest.error).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
