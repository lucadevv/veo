import type { CreateYapeAffiliation, YapeAffiliationView } from '@veo/api-client';
import type { AffiliationRepository } from './affiliationRepository';
import {
  AffiliationValidationError,
  CreateYapeAffiliationUseCase,
  GetYapeAffiliationUseCase,
  isDocumentValid,
  RevokeYapeAffiliationUseCase,
} from './affiliationUsecases';

/**
 * Doble de repositorio que registra la última entrada recibida y devuelve una vista fija. `lastCreate`
 * distingue `undefined` (el usecase NO llamó al repo) de `{}` o el objeto con documento (lo distinguimos
 * con un flag `called` aparte porque el flujo de UN TAP invoca con `undefined`).
 */
function makeRepo(view: YapeAffiliationView): {
  repo: AffiliationRepository;
  lastCreate: () => CreateYapeAffiliation | undefined;
  createCalledWithNoArg: () => boolean;
} {
  let lastCreate: CreateYapeAffiliation | undefined;
  let calledWithNoArg = false;
  const repo: AffiliationRepository = {
    getYapeAffiliation: jest.fn().mockResolvedValue(view),
    createYapeAffiliation: jest.fn((input?: CreateYapeAffiliation) => {
      lastCreate = input;
      if (input === undefined) {
        calledWithNoArg = true;
      }
      return Promise.resolve(view);
    }),
    revokeYapeAffiliation: jest.fn().mockResolvedValue({ ...view, status: 'REVOKED' }),
  };
  return { repo, lastCreate: () => lastCreate, createCalledWithNoArg: () => calledWithNoArg };
}

const PROCESS_VIEW: YapeAffiliationView = {
  status: 'PROCESS',
  affiliationId: 'aff_1',
  deepLink: 'yape://approve/aff_1',
  phoneMasked: '9*****678',
};

/** Body de fricción mínima (patrón PedidosYa): SOLO documento + tipo. Sin teléfono, sin nombre. */
const validInput: CreateYapeAffiliation = {
  documentType: 'DN',
  document: '12345678',
};

describe('CreateYapeAffiliationUseCase · validación', () => {
  it('rechaza un DNI que no tiene 8 dígitos (campo document)', async () => {
    const { repo } = makeRepo(PROCESS_VIEW);
    const useCase = new CreateYapeAffiliationUseCase(repo);
    expect.assertions(3);
    try {
      await useCase.execute({ ...validInput, document: '123' });
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliationValidationError);
      expect((err as AffiliationValidationError).field).toBe('document');
    }
    expect(repo.createYapeAffiliation).not.toHaveBeenCalled();
  });

  it('acepta una entrada válida, normaliza (trim) y NO agrega teléfono ni nombre', async () => {
    const { repo, lastCreate } = makeRepo(PROCESS_VIEW);
    const useCase = new CreateYapeAffiliationUseCase(repo);
    const view = await useCase.execute({ documentType: 'DN', document: ' 12345678 ' });
    expect(view.status).toBe('PROCESS');
    // El BFF resuelve el nombre del perfil y fija origin: la app SOLO manda documento + tipo.
    expect(lastCreate()).toEqual({ documentType: 'DN', document: '12345678' });
  });

  it('acepta CE alfanumérico de 9–12 (no exige 8 dígitos como el DNI)', async () => {
    const { repo } = makeRepo(PROCESS_VIEW);
    const useCase = new CreateYapeAffiliationUseCase(repo);
    await expect(
      useCase.execute({ documentType: 'CE', document: 'X12345678' }),
    ).resolves.toMatchObject({ status: 'PROCESS' });
  });
});

describe('CreateYapeAffiliationUseCase · flujo de UN TAP (body opcional)', () => {
  it('sin argumento → invoca al repo SIN body (el server resuelve documento+nombre del perfil)', async () => {
    const { repo, createCalledWithNoArg } = makeRepo(PROCESS_VIEW);
    const useCase = new CreateYapeAffiliationUseCase(repo);
    await expect(useCase.execute()).resolves.toMatchObject({ status: 'PROCESS' });
    // UN TAP: el usecase NO valida nada localmente y delega el body vacío al repo.
    expect(createCalledWithNoArg()).toBe(true);
  });

  it('con documento parcial (solo tipo, sin número) → trata como UN TAP (body vacío)', async () => {
    const { repo, createCalledWithNoArg } = makeRepo(PROCESS_VIEW);
    const useCase = new CreateYapeAffiliationUseCase(repo);
    // `document` ausente ⇒ no es "primera vez con documento": va por el flujo de un tap.
    await expect(
      useCase.execute({ documentType: 'DN' } as CreateYapeAffiliation),
    ).resolves.toMatchObject({ status: 'PROCESS' });
    expect(createCalledWithNoArg()).toBe(true);
  });
});

describe('isDocumentValid · reglas por tipo (DN 8 díg · CE 9–12 · PP 6–12)', () => {
  it('DN exige exactamente 8 dígitos', () => {
    expect(isDocumentValid('DN', '12345678')).toBe(true);
    expect(isDocumentValid('DN', '1234567')).toBe(false);
    expect(isDocumentValid('DN', '123456789')).toBe(false);
    expect(isDocumentValid('DN', 'ABCD5678')).toBe(false);
  });
  it('CE alfanumérico 9–12', () => {
    expect(isDocumentValid('CE', 'X12345678')).toBe(true); // 9
    expect(isDocumentValid('CE', 'X1234567')).toBe(false); // 8
    expect(isDocumentValid('CE', 'X12345678901')).toBe(true); // 12
    expect(isDocumentValid('CE', 'X123456789012')).toBe(false); // 13
  });
  it('PP alfanumérico 6–12', () => {
    expect(isDocumentValid('PP', 'AB1234')).toBe(true); // 6
    expect(isDocumentValid('PP', 'AB123')).toBe(false); // 5
    expect(isDocumentValid('PP', 'AB1234567890')).toBe(true); // 12
  });
});

describe('GetYapeAffiliationUseCase / RevokeYapeAffiliationUseCase', () => {
  it('lee el estado de la afiliación', async () => {
    const { repo } = makeRepo({ status: 'NONE' });
    const useCase = new GetYapeAffiliationUseCase(repo);
    await expect(useCase.execute()).resolves.toEqual({ status: 'NONE' });
  });

  it('revoca y devuelve REVOKED', async () => {
    const { repo } = makeRepo(PROCESS_VIEW);
    const useCase = new RevokeYapeAffiliationUseCase(repo);
    await expect(useCase.execute()).resolves.toMatchObject({ status: 'REVOKED' });
  });
});
