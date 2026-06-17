import {
  AddContactUseCase,
  ContactValidationError,
} from '../src/features/contacts/domain/usecases';
import type {ContactsRepository} from '../src/features/contacts/domain/contactsRepository';
import type {
  NewTrustedContact,
  TrustedContact,
} from '../src/features/contacts/domain/entities';

class FakeContactsRepository implements ContactsRepository {
  add = jest.fn(
    async (input: NewTrustedContact): Promise<TrustedContact> => ({
      id: 'c-1',
      name: input.name,
      phone: input.phone,
      relationship: input.relationship,
      verified: false,
    }),
  );
  list = jest.fn(async (): Promise<TrustedContact[]> => []);
  verify = jest.fn(async (): Promise<TrustedContact> => ({}) as TrustedContact);
  resend = jest.fn(async (): Promise<void> => undefined);
  remove = jest.fn(async (): Promise<void> => undefined);
}

describe('AddContactUseCase', () => {
  it('normaliza el teléfono (antepone 51) y agrega cuando los campos son válidos', async () => {
    const repo = new FakeContactsRepository();
    const useCase = new AddContactUseCase(repo);

    await useCase.execute({
      name: 'María Pérez',
      phone: '9 8765 4321',
      relationship: 'madre',
    });

    expect(repo.add).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '51987654321',
        name: 'María Pérez',
        relationship: 'madre',
      }),
    );
  });

  it('rechaza un teléfono inválido', () => {
    const repo = new FakeContactsRepository();
    const useCase = new AddContactUseCase(repo);

    expect(() =>
      useCase.execute({name: 'María', phone: '123', relationship: 'madre'}),
    ).toThrow(ContactValidationError);
    expect(repo.add).not.toHaveBeenCalled();
  });

  it('rechaza un parentesco vacío', () => {
    const repo = new FakeContactsRepository();
    const useCase = new AddContactUseCase(repo);

    expect(() =>
      useCase.execute({name: 'María', phone: '987654321', relationship: ''}),
    ).toThrow(/relationship|parentesco/i);
  });
});
