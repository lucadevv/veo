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
import { UpdateProfileUseCase } from '../usecases/update-profile';

const INPUT: UpdatePersonalInput = {
  legalName: 'Carlos Ramírez Soto',
  dni: '12345678',
  birthDate: '1990-05-21',
};

const RESULT: PersonalData = {
  legalName: 'Carlos Ramírez Soto',
  dni: '12345678',
  birthDate: '1990-05-21',
};

/** Doble de repositorio: captura el input y devuelve la vista persistida. */
class FakeProfileRepository implements ProfileRepository {
  calledWith: UpdatePersonalInput | null = null;

  getMe(): Promise<DriverProfile> {
    throw new Error('no usado');
  }

  onboard(_input: OnboardInput): Promise<OnboardResult> {
    throw new Error('no usado');
  }

  updatePersonal(input: UpdatePersonalInput): Promise<PersonalData> {
    this.calledWith = input;
    return Promise.resolve(RESULT);
  }

  requestPhoneChange(_phone: string): Promise<void> {
    throw new Error('no usado');
  }

  verifyPhoneChange(_phone: string, _code: string): Promise<PhoneChanged> {
    throw new Error('no usado');
  }

  requestDeletion(): Promise<DeletionRequested> {
    throw new Error('no usado');
  }
}

describe('UpdateProfileUseCase', () => {
  it('delega el body de datos personales al repositorio y devuelve la vista', async () => {
    const repo = new FakeProfileRepository();

    const result = await new UpdateProfileUseCase(repo).execute(INPUT);

    expect(repo.calledWith).toEqual(INPUT);
    expect(result).toEqual(RESULT);
  });
});
