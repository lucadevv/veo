import { isValidPeruPhone, normalizePeruPhone } from '../../../shared/utils/phone';
import type { ContactsRepository } from './contactsRepository';
import type { NewTrustedContact, TrustedContact } from './entities';

/** Error de validación de contacto (campo concreto inválido). */
export class ContactValidationError extends Error {
  constructor(readonly field: 'phone' | 'name' | 'relationship' | 'email') {
    super(`Contacto inválido: ${field}`);
    this.name = 'ContactValidationError';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lista los contactos de confianza del pasajero. */
export class ListContactsUseCase {
  constructor(private readonly repository: ContactsRepository) {}

  execute(): Promise<TrustedContact[]> {
    return this.repository.list();
  }
}

/**
 * Agrega un contacto validando los campos según el DTO real del bff (SRP: la validación vive aquí,
 * no en el widget). El tope de 3 contactos lo refuerza el bff y la UI deshabilita el alta al llegar.
 */
export class AddContactUseCase {
  constructor(private readonly repository: ContactsRepository) {}

  execute(input: NewTrustedContact): Promise<TrustedContact> {
    const phone = normalizePeruPhone(input.phone);
    if (!isValidPeruPhone(phone)) {
      throw new ContactValidationError('phone');
    }
    if (input.name.trim().length < 2 || input.name.trim().length > 80) {
      throw new ContactValidationError('name');
    }
    if (input.relationship.trim().length < 2 || input.relationship.trim().length > 40) {
      throw new ContactValidationError('relationship');
    }
    if (input.email && !EMAIL_PATTERN.test(input.email)) {
      throw new ContactValidationError('email');
    }
    return this.repository.add({
      phone,
      name: input.name.trim(),
      relationship: input.relationship.trim(),
      ...(input.email ? { email: input.email.trim() } : {}),
    });
  }
}

/** Verifica el OTP de un contacto (6 dígitos). */
export class VerifyContactUseCase {
  constructor(private readonly repository: ContactsRepository) {}

  execute(contactId: string, code: string): Promise<TrustedContact> {
    return this.repository.verify(contactId, code);
  }
}

/** Reenvía el OTP a un contacto pendiente. */
export class ResendContactOtpUseCase {
  constructor(private readonly repository: ContactsRepository) {}

  execute(contactId: string): Promise<void> {
    return this.repository.resend(contactId);
  }
}

/** Elimina un contacto de confianza. */
export class RemoveContactUseCase {
  constructor(private readonly repository: ContactsRepository) {}

  execute(contactId: string): Promise<void> {
    return this.repository.remove(contactId);
  }
}
