import {
  isKycVerified,
  mapKycStatus,
  type KycChallenge,
  type KycFrame,
} from '../src/features/kyc/domain/entities';
import type {
  KycRepository,
  KycSubmission,
  KycSubmissionResult,
} from '../src/features/kyc/domain/kycRepository';
import {
  KycValidationError,
  MAX_KYC_FRAMES,
  RequestKycChallengeUseCase,
  SubmitKycUseCase,
} from '../src/features/kyc/domain/usecases';
import {
  KYC_CHALLENGE_PATH,
  KYC_SUBMIT_PATH,
  kycChallengeResponse,
  kycSubmitRequest,
  kycSubmitResponse,
} from '../src/features/kyc/data/kycContract';

const frame = (overrides: Partial<KycFrame> = {}): KycFrame => ({
  base64Jpeg: 'AAAA',
  width: 480,
  height: 640,
  capturedAt: 1_700_000_000_000,
  ...overrides,
});

const challenge = (overrides: Partial<KycChallenge> = {}): KycChallenge => ({
  challengeId: 'chal-1',
  action: 'BLINK',
  instructions: 'Parpadea dos veces mirando a la cámara',
  expiresAt: '2026-05-30T12:00:00.000Z',
  ...overrides,
});

class FakeKycRepository implements KycRepository {
  requestChallenge = jest.fn(async (): Promise<KycChallenge> => challenge());
  submit = jest.fn(
    async (_input: KycSubmission): Promise<KycSubmissionResult> => ({ status: 'pending' }),
  );
}

describe('mapKycStatus', () => {
  it('normaliza variantes de aprobado/verificado a "approved"', () => {
    expect(mapKycStatus('APPROVED')).toBe('approved');
    expect(mapKycStatus('verified')).toBe('approved');
    expect(mapKycStatus('Passed')).toBe('approved');
  });

  it('normaliza variantes de revisión a "pending"', () => {
    expect(mapKycStatus('PENDING')).toBe('pending');
    expect(mapKycStatus('in_review')).toBe('pending');
    expect(mapKycStatus('submitted')).toBe('pending');
  });

  it('normaliza variantes de rechazo a "rejected"', () => {
    expect(mapKycStatus('REJECTED')).toBe('rejected');
    expect(mapKycStatus('failed')).toBe('rejected');
    expect(mapKycStatus('denied')).toBe('rejected');
  });

  it('cae en "unverified" ante valores vacíos o desconocidos', () => {
    expect(mapKycStatus('')).toBe('unverified');
    expect(mapKycStatus(null)).toBe('unverified');
    expect(mapKycStatus(undefined)).toBe('unverified');
    expect(mapKycStatus('algo-raro')).toBe('unverified');
  });

  it('isKycVerified sólo es true cuando el estado mapea a approved', () => {
    expect(isKycVerified('APPROVED')).toBe(true);
    expect(isKycVerified('pending')).toBe(false);
    expect(isKycVerified('')).toBe(false);
  });
});

describe('kycContract (parseo del contrato local)', () => {
  it('expone las rutas recomendadas del bff', () => {
    expect(KYC_SUBMIT_PATH).toBe('/kyc/verifications');
    expect(KYC_CHALLENGE_PATH).toBe('/kyc/challenge');
  });

  it('parsea la respuesta del reto de liveness activo', () => {
    const parsed = kycChallengeResponse.safeParse({
      challengeId: 'chal-1',
      action: 'BLINK',
      instructions: 'Parpadea dos veces mirando a la cámara',
      expiresAt: '2026-05-30T12:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.challengeId).toBe('chal-1');
    expect(parsed.success && parsed.data.action).toBe('BLINK');
  });

  it('rechaza un reto sin challengeId, action o instructions', () => {
    expect(
      kycChallengeResponse.safeParse({
        action: 'BLINK',
        instructions: 'x',
        expiresAt: '2026-05-30T12:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      kycChallengeResponse.safeParse({
        challengeId: 'chal-1',
        action: '',
        instructions: 'x',
        expiresAt: '2026-05-30T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('valida un request con challengeId y frames bien formados', () => {
    const parsed = kycSubmitRequest.safeParse({ challengeId: 'chal-1', frames: [frame()] });
    expect(parsed.success).toBe(true);
  });

  it('rechaza un request sin challengeId', () => {
    expect(kycSubmitRequest.safeParse({ frames: [frame()] }).success).toBe(false);
    expect(kycSubmitRequest.safeParse({ challengeId: '', frames: [frame()] }).success).toBe(false);
  });

  it('rechaza un request sin frames', () => {
    expect(kycSubmitRequest.safeParse({ challengeId: 'chal-1', frames: [] }).success).toBe(false);
  });

  it('rechaza un frame con base64 vacío o dimensiones no positivas', () => {
    expect(
      kycSubmitRequest.safeParse({ challengeId: 'chal-1', frames: [frame({ base64Jpeg: '' })] })
        .success,
    ).toBe(false);
    expect(
      kycSubmitRequest.safeParse({ challengeId: 'chal-1', frames: [frame({ width: 0 })] }).success,
    ).toBe(false);
  });

  it('parsea la respuesta con status libre y campos opcionales', () => {
    const parsed = kycSubmitResponse.safeParse({
      status: 'PENDING',
      verificationId: 'kyc-1',
      reason: undefined,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe('PENDING');
  });

  it('rechaza una respuesta sin status', () => {
    expect(kycSubmitResponse.safeParse({ verificationId: 'kyc-1' }).success).toBe(false);
  });
});

describe('RequestKycChallengeUseCase', () => {
  it('delega en el repositorio y devuelve el reto de liveness activo', async () => {
    const repo = new FakeKycRepository();
    const useCase = new RequestKycChallengeUseCase(repo);

    const result = await useCase.execute();

    expect(repo.requestChallenge).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({ challengeId: 'chal-1', action: 'BLINK' }),
    );
  });
});

describe('SubmitKycUseCase', () => {
  it('envía el challengeId junto a los frames cuando hay al menos un frame válido', async () => {
    const repo = new FakeKycRepository();
    const useCase = new SubmitKycUseCase(repo);

    await useCase.execute('chal-7', [frame()]);

    expect(repo.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'chal-7',
        frames: expect.arrayContaining([expect.objectContaining({ base64Jpeg: 'AAAA' })]),
      }),
    );
  });

  it('rechaza cuando falta el challengeId del reto', () => {
    const repo = new FakeKycRepository();
    const useCase = new SubmitKycUseCase(repo);

    expect(() => useCase.execute('   ', [frame()])).toThrow(KycValidationError);
    expect(repo.submit).not.toHaveBeenCalled();
  });

  it('rechaza cuando no hay frames', () => {
    const repo = new FakeKycRepository();
    const useCase = new SubmitKycUseCase(repo);

    expect(() => useCase.execute('chal-1', [])).toThrow(KycValidationError);
    expect(repo.submit).not.toHaveBeenCalled();
  });

  it('rechaza cuando algún frame tiene base64 vacío', () => {
    const repo = new FakeKycRepository();
    const useCase = new SubmitKycUseCase(repo);

    expect(() => useCase.execute('chal-1', [frame({ base64Jpeg: '   ' })])).toThrow(
      KycValidationError,
    );
    expect(repo.submit).not.toHaveBeenCalled();
  });

  it('recorta los frames al máximo permitido antes de enviar', async () => {
    const repo = new FakeKycRepository();
    const useCase = new SubmitKycUseCase(repo);

    await useCase.execute('chal-1', Array.from({ length: MAX_KYC_FRAMES + 3 }, () => frame()));

    const submitted = repo.submit.mock.calls[0][0];
    expect(submitted.frames).toHaveLength(MAX_KYC_FRAMES);
    expect(submitted.challengeId).toBe('chal-1');
  });

  it('propaga el resultado del repositorio (status mapeado por la capa data)', async () => {
    const repo = new FakeKycRepository();
    repo.submit.mockResolvedValueOnce({ status: 'approved', verificationId: 'kyc-9' });
    const useCase = new SubmitKycUseCase(repo);

    const result = await useCase.execute('chal-1', [frame()]);

    expect(result).toEqual({ status: 'approved', verificationId: 'kyc-9' });
  });
});

// NOTA: la fuente de captura por módulo nativo (NativeKycFrameSource) se retiró al migrar el KYC a
// detección facial en vivo con VisionCamera (la captura ahora vive en KycCameraScreen). Sus tests se
// eliminaron con el código muerto.
