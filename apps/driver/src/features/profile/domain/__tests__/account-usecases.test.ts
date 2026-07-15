import type {
  DeletionRequested,
  DriverProfile,
  OnboardInput,
  OnboardResult,
  PersonalData,
  PhoneChanged,
  ProfileRepository,
  UpdatePersonalInput,
} from '..';
import { RequestAccountDeletionUseCase } from '../usecases/request-account-deletion';
import {
  PhoneChangeValidationError,
  RequestPhoneChangeUseCase,
  VerifyPhoneChangeUseCase,
} from '../usecases/change-phone';

const GRACE = { graceUntil: '2026-08-14T00:00:00.000Z' };
const CHANGED: PhoneChanged = { phone: '+51999888777' };

/** Doble de repositorio: captura las llamadas de cuenta (phone-link + derecho al olvido). */
class FakeProfileRepository implements ProfileRepository {
  requestPhoneCalledWith: string | null = null;
  verifyCalledWith: { phone: string; code: string } | null = null;
  deletionCalls = 0;

  getMe(): Promise<DriverProfile> {
    throw new Error('no usado');
  }

  onboard(_input: OnboardInput): Promise<OnboardResult> {
    throw new Error('no usado');
  }

  updatePersonal(_input: UpdatePersonalInput): Promise<PersonalData> {
    throw new Error('no usado');
  }

  requestPhoneChange(phone: string): Promise<void> {
    this.requestPhoneCalledWith = phone;
    return Promise.resolve();
  }

  verifyPhoneChange(phone: string, code: string): Promise<PhoneChanged> {
    this.verifyCalledWith = { phone, code };
    return Promise.resolve(CHANGED);
  }

  requestDeletion(): Promise<DeletionRequested> {
    this.deletionCalls += 1;
    return Promise.resolve(GRACE);
  }
}

describe('RequestPhoneChangeUseCase (cambio de número, OTP al número NUEVO)', () => {
  it('delega el número válido al repositorio', async () => {
    const repo = new FakeProfileRepository();

    await new RequestPhoneChangeUseCase(repo).execute('987654321');

    expect(repo.requestPhoneCalledWith).toBe('987654321');
  });

  it('rechaza un número inválido LOCALMENTE (sin tocar la red)', async () => {
    const repo = new FakeProfileRepository();

    await expect(new RequestPhoneChangeUseCase(repo).execute('12345')).rejects.toBeInstanceOf(
      PhoneChangeValidationError,
    );
    expect(repo.requestPhoneCalledWith).toBeNull();
  });
});

describe('VerifyPhoneChangeUseCase (el número verificado pasa a ser el de login)', () => {
  it('delega phone+code y devuelve el teléfono ya vinculado', async () => {
    const repo = new FakeProfileRepository();

    const result = await new VerifyPhoneChangeUseCase(repo).execute('987654321', '123456');

    expect(repo.verifyCalledWith).toEqual({ phone: '987654321', code: '123456' });
    expect(result).toEqual(CHANGED);
  });

  it('rechaza un número inválido LOCALMENTE (sin gastar intentos del OTP)', async () => {
    const repo = new FakeProfileRepository();

    await expect(
      new VerifyPhoneChangeUseCase(repo).execute('no-numero', '123456'),
    ).rejects.toBeInstanceOf(PhoneChangeValidationError);
    expect(repo.verifyCalledWith).toBeNull();
  });
});

describe('RequestAccountDeletionUseCase (derecho al olvido, Ley 29733)', () => {
  it('delega al repositorio y devuelve el fin de la gracia', async () => {
    const repo = new FakeProfileRepository();

    const result = await new RequestAccountDeletionUseCase(repo).execute();

    expect(repo.deletionCalls).toBe(1);
    expect(result).toEqual(GRACE);
  });
});
