import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ApiError } from '@veo/api-client';
import type { FaceCapture, FaceCaptureService } from '../../../domain';
import { FacePhotoGrabberUnavailableError } from '../../../domain';
import {
  useRegistrationFaceCapture,
  SelfiePhase,
  type SelfieErrorSource,
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

// Spies de las mutaciones reales (enroll/submit). El prefijo `mock` es OBLIGATORIO: jest hoistea las
// factories de `jest.mock()` por encima de estas declaraciones y solo permite referenciar variables fuera
// de scope cuyo nombre empiece con `mock` (case-insensitive).
const mockEnrollMutateAsync = jest.fn<Promise<unknown>, [unknown]>();
const mockSubmitMutateAsync = jest.fn<Promise<unknown>, []>();

jest.mock('../useRegistrationDocuments', () => ({
  useEnrollBiometric: () => ({ mutateAsync: mockEnrollMutateAsync }),
}));

jest.mock('../useRegistrationSubmit', () => ({
  useRegistrationSubmit: () => ({ mutateAsync: mockSubmitMutateAsync }),
}));

// El servicio de captura facial inyectado: entrega la `FaceCapture` que el test configure (o lanza).
const mockCaptureForRegistration = jest.fn<Promise<FaceCapture>, []>();

jest.mock('../../providers/FaceCaptureProvider', () => ({
  useFaceCapture: (): FaceCaptureService =>
    ({ captureForRegistration: mockCaptureForRegistration }) as FaceCaptureService,
}));

interface HookSnapshot {
  phase: SelfiePhase;
  photo: string | null;
  error: unknown;
  errorSource: SelfieErrorSource | null;
  enrollErrorKind: ReturnType<typeof useRegistrationFaceCapture>['enrollErrorKind'];
  capture: () => Promise<void>;
  confirm: () => Promise<void>;
  retake: () => void;
  retry: () => void;
}

/** Probe: expone el resultado del hook para manejarlo desde el test. */
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
  let latest = {} as HookSnapshot;
  await act(async () => {
    TestRenderer.create(<Probe onRender={(snap) => (latest = snap)} />);
  });
  return { current: () => latest };
}

const PHOTO = 'a'.repeat(3000);

function faceCapture(photoBase64?: string): FaceCapture {
  return { ref: 'kyc-1', score: 1, capturedAt: '2026-06-20T00:00:00.000Z', photoBase64 };
}

describe('useRegistrationFaceCapture · KYC de una selfie del alta', () => {
  beforeEach(() => {
    mockEnrollMutateAsync.mockReset().mockResolvedValue(undefined);
    mockSubmitMutateAsync.mockReset().mockResolvedValue(undefined);
    mockCaptureForRegistration.mockReset().mockResolvedValue(faceCapture(PHOTO));
  });

  it('arranca en idle (cámara encuadrando), sin foto ni error', async () => {
    const hook = await mountHook();
    expect(hook.current().phase).toBe(SelfiePhase.IDLE);
    expect(hook.current().photo).toBeNull();
    expect(hook.current().error).toBeNull();
  });

  it('capture ⇒ toma 1 foto y pasa a preview (NO enrola todavía)', async () => {
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();

    expect(mockCaptureForRegistration).toHaveBeenCalledTimes(1);
    expect(hook.current().phase).toBe(SelfiePhase.PREVIEW);
    expect(hook.current().photo).toBe(PHOTO);
    // El enroll/submit NO corren hasta confirmar.
    expect(mockEnrollMutateAsync).not.toHaveBeenCalled();
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
  });

  it('confirm ⇒ enrola { photo } y LUEGO cierra (orden enroll→submit) ⇒ success', async () => {
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockEnrollMutateAsync).toHaveBeenCalledWith({ photo: PHOTO });
    expect(mockSubmitMutateAsync).toHaveBeenCalledTimes(1);
    const enrollOrder = mockEnrollMutateAsync.mock.invocationCallOrder[0];
    const submitOrder = mockSubmitMutateAsync.mock.invocationCallOrder[0];
    expect(enrollOrder).toBeLessThan(submitOrder as number);

    expect(hook.current().phase).toBe(SelfiePhase.SUCCESS);
    expect(hook.current().error).toBeNull();
  });

  it('captura sin foto real (stub) ⇒ failed clasificado missing-capture; NO enrola', async () => {
    mockCaptureForRegistration.mockResolvedValueOnce(faceCapture(undefined));
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();

    expect(mockEnrollMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().errorSource).toBe('capture');
  });

  it('cámara no disponible ⇒ failed con source capture (módulo nativo no enlazado)', async () => {
    mockCaptureForRegistration.mockRejectedValueOnce(new FacePhotoGrabberUnavailableError());
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();

    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().errorSource).toBe('capture');
    expect(hook.current().enrollErrorKind).toBeNull();
  });

  it('enroll rechaza 422 "rostro" ⇒ failed clasificado face; NO cierra', async () => {
    mockEnrollMutateAsync
      .mockReset()
      .mockRejectedValueOnce(
        new ApiError(422, 'UNPROCESSABLE', 'La imagen debe contener exactamente un rostro'),
      );
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().errorSource).toBe('enroll');
    expect(hook.current().enrollErrorKind).toBe('face');
  });

  it('enroll rechaza 422 con reason "spoof" (PAD pasivo) ⇒ failed clasificado spoof; NO cierra', async () => {
    mockEnrollMutateAsync
      .mockReset()
      .mockRejectedValueOnce(
        new ApiError(422, 'UNPROCESSABLE_ENTITY', 'No detectamos a una persona real', {
          reason: 'spoof',
        }),
      );
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().errorSource).toBe('enroll');
    expect(hook.current().enrollErrorKind).toBe('spoof');
  });

  it('enroll rechaza 422 con reason "no_face" ⇒ failed clasificado face (no spoof); NO cierra', async () => {
    mockEnrollMutateAsync
      .mockReset()
      .mockRejectedValueOnce(
        new ApiError(422, 'UNPROCESSABLE_ENTITY', 'No detectamos tu rostro', {
          reason: 'no_face',
        }),
      );
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().enrollErrorKind).toBe('face');
  });

  it('enroll falla por red (status 0) ⇒ failed clasificado network; NO cierra', async () => {
    mockEnrollMutateAsync
      .mockReset()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'Sin conexión'));
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().enrollErrorKind).toBe('network');
  });

  it('si el enroll falla, NO se llama a submit (el cierre depende del enroll)', async () => {
    mockEnrollMutateAsync.mockReset().mockRejectedValueOnce(new Error('enroll boom'));
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();

    expect(mockEnrollMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockSubmitMutateAsync).not.toHaveBeenCalled();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);
    expect(hook.current().errorSource).toBe('enroll');
  });

  it('retake desde preview ⇒ vuelve a idle y descarta la foto', async () => {
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    expect(hook.current().phase).toBe(SelfiePhase.PREVIEW);

    await act(async () => {
      hook.current().retake();
    });
    await tick();
    expect(hook.current().phase).toBe(SelfiePhase.IDLE);
    expect(hook.current().photo).toBeNull();
  });

  it('retry tras fallo ⇒ vuelve a idle; una segunda captura+confirm exitosa cierra', async () => {
    mockEnrollMutateAsync
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const hook = await mountHook();
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();
    expect(hook.current().phase).toBe(SelfiePhase.FAILED);

    await act(async () => {
      hook.current().retry();
    });
    await tick();
    expect(hook.current().phase).toBe(SelfiePhase.IDLE);
    expect(hook.current().photo).toBeNull();

    // Segundo intento completo: captura → confirm → success.
    await act(async () => {
      await hook.current().capture();
    });
    await tick();
    await act(async () => {
      await hook.current().confirm();
    });
    await tick();
    expect(mockSubmitMutateAsync).toHaveBeenCalledTimes(1);
    expect(hook.current().phase).toBe(SelfiePhase.SUCCESS);
  });
});
