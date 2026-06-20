import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivenessAction } from '@veo/shared-types';
import type { LivenessChallenge, LivenessFrameGrabber } from '../../../domain';
import type { DriverProfile } from '../../../../profile/domain';
import { DiProvider } from '../../../../../core/di/useDi';
import type { AppContainer } from '../../../../../core/di/container';
import { useSessionStore } from '../../../../../core/session/sessionStore';
import { useRegistrationStore } from '../../state/registrationStore';
import { useRegistrationFaceCapture, LivenessPhase } from '../useRegistrationFaceCapture';

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

// El enroll de biometría y el reto de liveness se cablean al repositorio real vía DI; en este test los
// resolvemos con dobles: el reto SIEMPRE entrega un reto válido y el enroll SIEMPRE enrola OK (200). El
// foco es el CIERRE post-enroll (el camino antes roto), NO el liveness en sí. `useRegistrationSubmit` NO
// se mockea: ejercitamos el camino REAL (GET /me → map → store).
const LIVENESS_CHALLENGE: LivenessChallenge = {
  challengeId: 'chal-1',
  action: LivenessAction.TURN_LEFT,
  instructions: 'Gira la cabeza a la izquierda',
  expiresAt: '2026-06-19T00:01:00.000Z',
};
const mockGetLivenessChallenge = jest.fn<Promise<LivenessChallenge>, []>(() =>
  Promise.resolve(LIVENESS_CHALLENGE),
);
const mockEnrollBiometric = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({ enrolled: true, enrolledAt: '2026-06-19T00:00:00.000Z' }),
);

// El grabber de liveness inyectado entrega frames marcadores (la captura real es nativa).
const mockCaptureFrames = jest.fn<Promise<string[]>, Parameters<LivenessFrameGrabber['captureFrames']>>(
  () => Promise.resolve(['frame1', 'frame2', 'frame3']),
);

jest.mock('../../providers/LivenessCaptureProvider', () => ({
  useLivenessGrabber: (): LivenessFrameGrabber =>
    ({ captureFrames: mockCaptureFrames }) as unknown as LivenessFrameGrabber,
}));

/**
 * Perfil de un conductor que RESUMIÓ el alta directo en el paso de KYC: el backend YA tiene todos los
 * documentos requeridos (`submittedAllRequired`) y —tras este enroll— la biometría (`biometricEnrolled`).
 * Falta solo la validación del operador (docs en revisión, KYC/antecedentes pendientes) ⇒ el mapeo de
 * dominio lo proyecta a `in_review`. Es el ESCENARIO QUE ROMPÍA: el draft LOCAL está vacío en
 * personal/vehículo (esos datos viven en el server, no en el store fresco), así que el viejo gate de
 * `isDraftComplete` rechazaba con un error de dominio enmascarado como "generic".
 */
const RESUMED_SERVER_COMPLETE: DriverProfile = {
  driverId: 'drv-1',
  userId: 'usr-1',
  phone: '+51987654321',
  kycStatus: 'PENDING',
  currentStatus: 'OFFLINE',
  backgroundCheckStatus: 'PENDING',
  rejectionReason: null,
  averageRating: 0,
  rating: null,
  documents: [],
  compliance: {
    compliant: false,
    requiredTypes: [],
    missing: [],
    rejected: [],
    submittedAllRequired: true,
    allApproved: false,
    biometricEnrolled: true,
  },
};

function makeContainer(getMe: jest.Mock): AppContainer {
  return {
    repositories: {
      profile: { getMe, onboard: jest.fn() },
      registration: {
        enrollBiometric: mockEnrollBiometric,
        getLivenessChallenge: mockGetLivenessChallenge,
      },
    },
  } as unknown as AppContainer;
}

interface HookSnapshot {
  phase: LivenessPhase;
  enrollErrorKind: ReturnType<typeof useRegistrationFaceCapture>['enrollErrorKind'];
  error: unknown;
  start: () => Promise<void>;
}

/** Probe: expone el resultado del hook para manejarlo desde el test. */
function Probe({ onRender }: { onRender: (snap: HookSnapshot) => void }) {
  const hook = useRegistrationFaceCapture();
  onRender(hook);
  return null;
}

function withProviders(node: ReactElement, client: QueryClient, container: AppContainer) {
  return (
    <QueryClientProvider client={client}>
      <DiProvider container={container}>{node}</DiProvider>
    </QueryClientProvider>
  );
}

async function flush(): Promise<void> {
  // react-query notifica a los observers en un setTimeout(0); macro-task ticks dejan resolver la query
  // del reto + la mutación + aplicar los efectos en el store (applyBackendStatus / setCurrentStep / setUser).
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useRegistrationFaceCapture · cierre del KYC en alta REANUDADA (camino real, sin mock de submit)', () => {
  beforeEach(() => {
    useRegistrationStore.getState().reset();
    useSessionStore.setState({
      status: 'authenticated',
      accessToken: 'acc',
      refreshToken: 'ref',
      user: null,
      expired: false,
    });
    mockEnrollBiometric.mockClear();
    mockGetLivenessChallenge.mockClear();
    mockCaptureFrames.mockClear();
  });

  it('draft local VACÍO (resume) + server completo ⇒ tras enroll cierra contra el server y rutea a in_review, SIN error de dominio/generic', async () => {
    // Pre-condición del bug: el store está fresco (reset) → personal/vehículo vacíos. El viejo gate de
    // `isDraftComplete(buildDraft())` daría false y rechazaría. Lo confirmamos explícitamente.
    const draft = useRegistrationStore.getState().buildDraft();
    expect(draft.personal.fullName).toBe('');
    expect(draft.vehicle.plate).toBe('');

    const getMe = jest.fn(() => Promise.resolve(RESUMED_SERVER_COMPLETE));
    const container = makeContainer(getMe);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let snap: HookSnapshot = {
      phase: LivenessPhase.REQUESTING_CHALLENGE,
      enrollErrorKind: null,
      error: null,
      start: async () => undefined,
    };
    await act(async () => {
      TestRenderer.create(withProviders(<Probe onRender={(s) => (snap = s)} />, client, container));
    });

    // La query del reto resuelve → fase `ready`; recién entonces el conductor inicia el gesto.
    await flush();
    expect(snap.phase).toBe(LivenessPhase.READY);

    await act(async () => {
      await snap.start();
    });
    await flush();

    // El reto se pidió, el enroll corrió (200) y el cierre consultó al SERVER (no al draft local).
    expect(mockGetLivenessChallenge).toHaveBeenCalledTimes(1);
    expect(mockEnrollBiometric).toHaveBeenCalledTimes(1);
    expect(getMe).toHaveBeenCalledTimes(1);

    // NO hubo error de dominio enmascarado: ni IncompleteRegistrationError ni banner generic/incomplete.
    expect(snap.error).toBeNull();
    expect(snap.enrollErrorKind).toBeNull();
    expect(snap.phase).toBe(LivenessPhase.SUCCESS);

    // El backend (server-truth) decide: docs + biometría completos ⇒ in_review. El RootNavigator conmuta
    // a "estamos revisando tus datos". El store se sincronizó con la MISMA lógica del gate (no duplicada).
    expect(useRegistrationStore.getState().status).toBe('in_review');
    expect(useRegistrationStore.getState().statusResolvedFromBackend).toBe(true);
    // El user de sesión se compuso del perfil resuelto (igual que hace el gate).
    expect(useSessionStore.getState().user).toEqual({
      id: 'usr-1',
      phone: '+51987654321',
      type: 'driver',
      kycStatus: 'PENDING',
    });
  });
});
