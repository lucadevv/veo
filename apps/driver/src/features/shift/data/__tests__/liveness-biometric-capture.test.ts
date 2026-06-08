import {LivenessBiometricCaptureService} from '../services/liveness-biometric-capture';
import type {
  BiometricBackendPort,
  BiometricChallenge,
  BiometricEnrollResult,
  BiometricVerificationInput,
  BiometricVerifyOutcome,
} from '../../domain';
import type {
  BiometricFrameGrabber,
  FrameCapturePlan,
} from '../../domain';

/** Frame-grabber de prueba: devuelve frames sintéticos y registra el plan recibido. */
class FakeGrabber implements BiometricFrameGrabber {
  lastPlan: FrameCapturePlan | null = null;
  photoTaken = false;
  captureSequence(plan: FrameCapturePlan): Promise<string[]> {
    this.lastPlan = plan;
    return Promise.resolve(Array.from({length: plan.frameCount}, (_, i) => `frame-${i}`));
  }
  capturePhoto(): Promise<string> {
    this.photoTaken = true;
    return Promise.resolve('photo-b64');
  }
}

/** Backend de prueba que captura las entradas y responde con valores fijos. */
class FakeBackend implements BiometricBackendPort {
  verifyInput: BiometricVerificationInput | null = null;
  enrolledPhoto: string | null = null;
  requestChallenge(): Promise<BiometricChallenge> {
    return Promise.resolve({
      challengeId: 'c-1',
      action: 'BLINK',
      instructions: 'Parpadea',
      expiresAt: '2026-05-29T00:00:00Z',
    });
  }
  verify(input: BiometricVerificationInput): Promise<BiometricVerifyOutcome> {
    this.verifyInput = input;
    return Promise.resolve({sessionRef: 'sess-9', score: 0.95, livenessPassed: true, matchPassed: true});
  }
  enroll(photoBase64: string): Promise<BiometricEnrollResult> {
    this.enrolledPhoto = photoBase64;
    return Promise.resolve({enrolledAt: '2026-05-29T00:00:00Z'});
  }
}

describe('LivenessBiometricCaptureService', () => {
  it('orquesta reto → captura (plan por acción) → verify → sessionRef', async () => {
    const grabber = new FakeGrabber();
    const backend = new FakeBackend();
    const service = new LivenessBiometricCaptureService(grabber, backend);

    const result = await service.captureForShiftStart();

    expect(grabber.lastPlan?.action).toBe('BLINK');
    expect(grabber.lastPlan?.frameCount).toBe(12);
    expect(backend.verifyInput).toEqual({challengeId: 'c-1', frames: expect.any(Array)});
    expect(backend.verifyInput?.frames).toHaveLength(12);
    expect(result).toEqual({sessionRef: 'sess-9', score: 0.95});
  });

  it('enroll captura una foto y la registra en el backend', async () => {
    const grabber = new FakeGrabber();
    const backend = new FakeBackend();
    const service = new LivenessBiometricCaptureService(grabber, backend);

    const result = await service.enroll();

    expect(grabber.photoTaken).toBe(true);
    expect(backend.enrolledPhoto).toBe('photo-b64');
    expect(result.enrolledAt).toBe('2026-05-29T00:00:00Z');
  });
});
