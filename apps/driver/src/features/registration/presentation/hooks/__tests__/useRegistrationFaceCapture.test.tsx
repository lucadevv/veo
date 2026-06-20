import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ApiError } from '@veo/api-client';
import { LivenessAction } from '@veo/shared-types';
import type { LivenessChallenge, LivenessFrameGrabber } from '../../../domain';
import {
  useRegistrationFaceCapture,
  LivenessPhase,
  type LivenessErrorSource,
} from '../useRegistrationFaceCapture';

// MMKV nativo no existe en Jest: stubeamos el storage para que el store no reviente al persistir.
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

// Spies de las mutaciones reales (enroll/submit). Los controla cada test para verificar el orden y el
// gate: `submit` NUNCA debe correr sin un `enroll` exitoso previo. El prefijo `mock` es OBLIGATORIO:
// jest hoistea las factories de `jest.mock()` por encima de estas declaraciones y solo permite
// referenciar variables fuera de scope cuyo nombre empiece con `mock` (case-insensitive).
const mockEnrollMutateAsync = jest.fn<Promise<unknown>, [unknown]>();
const mockSubmitMutateAsync = jest.fn<Promise<unknown>, []>();

// El reto de liveness lo entrega `useLivenessChallenge` (React Query). Lo mockeamos como una query ya
// resuelta (success) con el reto que el test configure, y un `refetch` espía para verificar el reintento
// (los retos son de un solo uso: `retry()` debe pedir un reto NUEVO, no reusar el consumido).
let mockChallengeData: LivenessChallenge | undefined;
let mockChallengeIsError = false;
let mockChallengeError: unknown = null;
const mockRefetch = jest.fn(() => Promise.resolve({ data: mockChallengeData }));

jest.mock('../useRegistrationDocuments', () => ({
  useEnrollBiometric: () => ({ mutateAsync: mockEnrollMutateAsync }),
  useLivenessChallenge: () => ({
    data: mockChallengeData,
    isSuccess: !mockChallengeIsError && mockChallengeData !== undefined,
    isError: mockChallengeIsError,
    error: mockChallengeError,
    refetch: mockRefetch,
  }),
}));

jest.mock('../useRegistrationSubmit', () => ({
  useRegistrationSubmit: () => ({ mutateAsync: mockSubmitMutateAsync }),
}));

// El grabber de liveness inyectado: captura los frames marcadores que el test configure y reporta
// progreso. Solo se invoca al iniciar el gesto (`start`).
let mockFrames: string[] = ['frame1', 'frame2', 'frame3'];
const mockCaptureFrames = jest.fn<Promise<string[]>, Parameters<LivenessFrameGrabber['captureFrames']>>(
  async (_plan, onProgress) => {
    onProgress?.(0.5);
    onProgress?.(1);
    return mockFrames;
  },
);

jest.mock('../../providers/LivenessCaptureProvider', () => ({
  useLivenessGrabber: (): LivenessFrameGrabber =>
    ({ captureFrames: mockCaptureFrames }) as unknown as LivenessFrameGrabber,
}));

interface HookSnapshot {
  phase: LivenessPhase;
  action: LivenessAction | null;
  instructions: string | null;
  captureProgress: number;
  error: unknown;
  errorSource: LivenessErrorSource | null;
  enrollErrorKind: ReturnType<typeof useRegistrationFaceCapture>['enrollErrorKind'];
  start: () => Promise<void>;
  retry: () => void;
}

/** Probe: expone el resultado del hook para manejarlo desde el test (patrón del gate test). */
function Probe({ onRender }: { onRender: (snap: HookSnapshot) => void }) {
  const hook = useRegistrationFaceCapture();
  onRender(hook);
  return null;
}

async function tick(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function mountHook(): Promise<{ current: () => HookSnapshot }> {
  let latest: HookSnapshot = {
    phase: LivenessPhase.REQUESTING_CHALLENGE,
    action: null,
    instructions: null,
    captureProgress: 0,
    error: null,
    errorSource: null,
    enrollErrorKind: null,
    start: async () => undefined,
    retry: () => undefined,
  };
  await act(async () => {
    TestRenderer.create(<Probe onRender={(snap) => (latest = snap)} />);
  });
  return { current: () => latest };
}

const TURN_LEFT_CHALLENGE: LivenessChallenge = {
  challengeId: 'chal-1',
  action: LivenessAction.TURN_LEFT,
  instructions: 'Gira la cabeza a la izquierda',
  expiresAt: '2026-06-19T00:01:00.000Z',
};

describe('useRegistrationFaceCapture · liveness reactivo del alta', () => {
  beforeEach(() => {
    mockEnrollMutateAsync.mockReset().mockResolvedValue(undefined);
    mockSubmitMutateAsync.mockReset().mockResolvedValue(undefined);
    mockCaptureFrames.mockClear();
    mockRefetch.mockClear();
    mockFrames = ['frame1', 'frame2', 'frame3'];
    mockChallengeData = TURN_LEFT_CHALLENGE;
    mockChallengeIsError = false;
    mockChallengeError = null;
  });

  it('reto OK ⇒ ready → performing → captura frames → enrola { challengeId, frames } y LUEGO cierra (orden enroll→submit) ⇒ success', async () => {
    const hook = await mountHook();
    // El efecto de la query promueve a `ready` con el reto resuelto (acción + instrucciones del server).
    await tick();
    expect(hook.current().phase).toBe(LivenessPhase.READY);
    expect(hook.current().action).toBe(LivenessAction.TURN_LEFT);
    expect(hook.current().instructions).toBe('Gira la cabeza a la izquierda');

    await act(async () => {
      await hook.current().start();
    });
    await tick();

    // Captura: el grabber recibió un plan y reportó progreso real hasta 1.
    expect(mockCaptureFrames).toHaveBeenCalledTimes(1);
    expect(hook.current().captureProgress).toBe(1);

    // Enroll con el contrato NUEVO: { challengeId, frames } (NO { photo }).
    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockEnrollMutateAsync).toHaveBeenCalledWith({
      challengeId: 'chal-1',
      frames: ['frame1', 'frame2', 'frame3'],
    });
    expect(mockSubmitMutateAsync).toHaveBeenCalledTimes(1);
    // Orden: enroll antes que submit (el enroll es prerequisito del cierre).
    const enrollOrder = mockEnrollMutateAsync.mock.invocationCallOrder[0];
    const submitOrder = mockSubmitMutateAsync.mock.invocationCallOrder[0];
    expect(enrollOrder).toBeDefined();
    expect(submitOrder).toBeDefined();
    expect(enrollOrder).toBeLessThan(submitOrder as number);

    expect(hook.current().phase).toBe(LivenessPhase.SUCCESS);
    expect(hook.current().error).toBeNull();
  });

  it('liveness-fail (enroll rechaza 422 con details.reason) ⇒ failed clasificado liveness; retry() pide un reto NUEVO y vuelve a ready', async () => {
    mockEnrollMutateAsync.mockReset().mockRejectedValueOnce(
      new ApiError(422, 'UNPROCESSABLE', 'Prueba de vida no superada', {
        reason: 'gesto incompleto',
      }),
    );
    const hook = await mountHook();
    await tick();
    expect(hook.current().phase).toBe(LivenessPhase.READY);

    await act(async () => {
      await hook.current().start();
    });
    await tick();

    // El enroll corrió pero falló: NO se cerró el alta y el error se clasifica como liveness.
    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(LivenessPhase.FAILED);
    expect(hook.current().errorSource).toBe('enroll');
    expect(hook.current().enrollErrorKind).toBe('liveness');

    // Reintento: pide un reto NUEVO (refetch) y vuelve a `requesting-challenge` → `ready`.
    // Simulamos que el server emite un reto distinto (challengeId nuevo) tras el refetch.
    mockChallengeData = { ...TURN_LEFT_CHALLENGE, challengeId: 'chal-2' };
    await act(async () => {
      hook.current().retry();
    });
    await tick();

    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(hook.current().phase).toBe(LivenessPhase.READY);
    expect(hook.current().error).toBeNull();
    expect(hook.current().enrollErrorKind).toBeNull();

    // Un segundo gesto exitoso usa el challengeId NUEVO (el consumido no se recicla).
    await act(async () => {
      await hook.current().start();
    });
    await tick();
    expect(mockEnrollMutateAsync).toHaveBeenLastCalledWith({
      challengeId: 'chal-2',
      frames: ['frame1', 'frame2', 'frame3'],
    });
  });

  it('si el enroll falla, NO se llama a submit (el cierre depende del enroll)', async () => {
    mockEnrollMutateAsync.mockReset().mockRejectedValueOnce(new Error('enroll boom'));
    const hook = await mountHook();
    await tick();

    await act(async () => {
      await hook.current().start();
    });
    await tick();

    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(LivenessPhase.FAILED);
    expect(hook.current().errorSource).toBe('enroll');
  });
});
