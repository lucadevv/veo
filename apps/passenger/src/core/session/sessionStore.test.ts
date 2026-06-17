import { useSessionStore } from './sessionStore';
import { initSecureStorage, secureStore } from '../storage/mmkv';

/**
 * Máquina de estados de auth: el MOTIVO de cierre decide el estado resultante, que es lo que el
 * RootNavigator usa para rutear (Auth vs SessionExpired). Cubre los tres caminos del hallazgo #3:
 * sesión expirada (refresh fallido), logout intencional del usuario, y cold-start sin sesión.
 */

const SESSION = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'u1', phone: '+51999999999' } as never,
};

// El almacén seguro ahora se crea ASYNC (instancia MMKV con la clave del Keychain) en
// `initSecureStorage()`; hay que inicializarlo antes de leer/escribir `secureStore` en los tests,
// igual que el bootstrap real (App.tsx lo encadena con `hydrate()`).
beforeAll(async () => {
  await initSecureStorage();
});

beforeEach(() => {
  secureStore.remove('session.accessToken');
  secureStore.remove('session.refreshToken');
  secureStore.remove('session.user');
  useSessionStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
    status: 'unknown',
  });
});

describe('sessionStore — máquina de estados de auth', () => {
  it('logout INTENCIONAL (default / user-logout) → unauthenticated → RootNavigator muestra Auth', () => {
    useSessionStore.getState().setSession(SESSION);
    expect(useSessionStore.getState().status).toBe('authenticated');

    useSessionStore.getState().clearSession(); // sin argumento = user-logout
    expect(useSessionStore.getState().status).toBe('unauthenticated');

    useSessionStore.getState().setSession(SESSION);
    useSessionStore.getState().clearSession('user-logout'); // explícito
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('sesión EXPIRADA (refresh fallido → reason expired) → expired → RootNavigator muestra SessionExpired', () => {
    useSessionStore.getState().setSession(SESSION);

    useSessionStore.getState().clearSession('expired');

    expect(useSessionStore.getState().status).toBe('expired');
    // La sesión se limpió igual que en cualquier cierre: sin tokens persistidos.
    expect(useSessionStore.getState().accessToken).toBeNull();
    expect(useSessionStore.getState().refreshToken).toBeNull();
    expect(secureStore.getString('session.accessToken')).toBeUndefined();
  });

  it('desde EXPIRED, re-login (user-logout) vuelve a unauthenticated (no reentra a expired)', () => {
    useSessionStore.getState().setSession(SESSION);
    useSessionStore.getState().clearSession('expired');
    expect(useSessionStore.getState().status).toBe('expired');

    // El CTA "Volver a iniciar sesión" de SessionExpiredScreen.
    useSessionStore.getState().clearSession('user-logout');
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('COLD-START sin tokens → hydrate → unauthenticated (Auth), nunca expired', () => {
    useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('COLD-START con sesión persistida → hydrate → authenticated', () => {
    secureStore.setString('session.accessToken', SESSION.accessToken);
    secureStore.setString('session.refreshToken', SESSION.refreshToken);

    useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().status).toBe('authenticated');
  });
});
