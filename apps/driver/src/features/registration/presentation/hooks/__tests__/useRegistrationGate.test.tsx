import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import type { DriverProfile } from '../../../../profile/domain';
import { DiProvider } from '../../../../../core/di/useDi';
import type { AppContainer } from '../../../../../core/di/container';
import { useSessionStore } from '../../../../../core/session/sessionStore';
import { useRegistrationStore } from '../../state/registrationStore';
import { useRegistrationGate, type RegistrationGate } from '../useRegistrationGate';

// MMKV nativo no existe en Jest: stubeamos el storage para que los stores no revienten al persistir.
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

/** Perfil de un conductor APROBADO (docs al día, KYC + antecedentes OK). */
const APPROVED_PROFILE: DriverProfile = {
  driverId: 'drv-1',
  userId: 'usr-1',
  phone: '+51987654321',
  kycStatus: 'APPROVED',
  currentStatus: 'OFFLINE',
  backgroundCheckStatus: 'CLEARED',
  rejectionReason: null,
  averageRating: 4.8,
  rating: null,
  documents: [],
  compliance: {
    compliant: true,
    requiredTypes: [],
    missing: [],
    rejected: [],
    submittedAllRequired: true,
    allApproved: true,
  },
};

function makeContainer(getMe: jest.Mock): AppContainer {
  return {
    repositories: { profile: { getMe, onboard: jest.fn() } },
  } as unknown as AppContainer;
}

/** Probe: expone el resultado del gate para inspeccionarlo desde el test. */
function GateProbe({ onResult }: { onResult: (gate: RegistrationGate) => void }) {
  const gate = useRegistrationGate();
  onResult(gate);
  return null;
}

function withProviders(node: ReactElement, client: QueryClient, container: AppContainer) {
  return (
    <QueryClientProvider client={client}>
      <DiProvider container={container}>{node}</DiProvider>
    </QueryClientProvider>
  );
}

/** Monta el gate con un `getMe` dado y espera a que la query resuelva (éxito o error). */
async function renderGate(getMe: jest.Mock): Promise<{ last: () => RegistrationGate }> {
  const container = makeContainer(getMe);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let last: RegistrationGate = { resolving: true, needsRetry: false, retry: () => undefined };
  await act(async () => {
    TestRenderer.create(
      withProviders(<GateProbe onResult={(g) => (last = g)} />, client, container),
    );
  });
  // react-query notifica a los observers en un `setTimeout(0)` (notifyManager batchea por timer), no
  // solo en microtasks. Macro-task ticks dejan que la query resuelva/erre Y que el re-render + effect
  // post-resolución (forceWizard / setUser / needsRetry) se apliquen.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { last: () => last };
}

describe('useRegistrationGate', () => {
  beforeEach(() => {
    useRegistrationStore.getState().reset();
    useSessionStore.setState({
      status: 'authenticated',
      accessToken: 'acc',
      refreshToken: 'ref',
      user: null,
      expired: false,
    });
  });

  it('404 (conductor nuevo) ⇒ forceWizard (status not_started, sin tocar la sesión)', async () => {
    const getMe = jest.fn(() =>
      Promise.reject(new ApiError(404, 'NOT_FOUND', 'No existe un perfil de conductor para este usuario')),
    );
    await renderGate(getMe);

    expect(useRegistrationStore.getState().status).toBe('not_started');
    expect(useRegistrationStore.getState().statusResolvedFromBackend).toBe(true);
    // 404 NO compone usuario (no hay perfil) y la sesión sigue autenticada (no se limpia).
    expect(useSessionStore.getState().user).toBeNull();
    expect(useSessionStore.getState().status).toBe('authenticated');
  });

  it('perfil aprobado ⇒ applyBackendStatus(approved) + compone session.user', async () => {
    const getMe = jest.fn(() => Promise.resolve(APPROVED_PROFILE));
    await renderGate(getMe);

    expect(useRegistrationStore.getState().status).toBe('approved');
    expect(useRegistrationStore.getState().statusResolvedFromBackend).toBe(true);
    // Regresión crítica: el `user` de sesión ahora lo compone el gate (el login ya no lo fetchea).
    expect(useSessionStore.getState().user).toEqual({
      id: 'usr-1',
      phone: '+51987654321',
      type: 'driver',
      kycStatus: 'APPROVED',
    });
  });

  it('error NO 404 (4xx no reintentable) ⇒ needsRetry, sin limpiar la sesión ni resolver el alta', async () => {
    // 403 NO es reintentable (no es 5xx/429/red) ni es 404 ⇒ surfacea de inmediato a `needsRetry`,
    // sin gastar el backoff real de los reintentos. Cubre el camino "error definitivo no-404".
    const getMe = jest.fn(() => Promise.reject(new ApiError(403, 'FORBIDDEN', 'sin permiso')));
    const { last } = await renderGate(getMe);

    expect(last().needsRetry).toBe(true);
    // No se resuelve el alta con un error transitorio (no forzamos wizard ni aprobamos).
    expect(useRegistrationStore.getState().statusResolvedFromBackend).toBe(false);
    // La sesión NO se limpia: los tokens siguen válidos, solo falló GET /drivers/me.
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().accessToken).toBe('acc');
  });
});
