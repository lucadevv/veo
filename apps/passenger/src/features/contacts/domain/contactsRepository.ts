import type {NewTrustedContact, TrustedContact} from './entities';

/**
 * Abstracción del repositorio de Contactos de Confianza (DIP). Implementación real contra el
 * public-bff `/contacts` (GET / POST / :id/verify-otp / :id/resend-otp / DELETE :id).
 */
export interface ContactsRepository {
  /** GET /contacts → lista los contactos de confianza del pasajero (máx. 3). */
  list(): Promise<TrustedContact[]>;
  /** POST /contacts → agrega un contacto y dispara el OTP de verificación. */
  add(input: NewTrustedContact): Promise<TrustedContact>;
  /** POST /contacts/:id/verify-otp → confirma la verificación OTP del contacto. */
  verify(contactId: string, code: string): Promise<TrustedContact>;
  /** POST /contacts/:id/resend-otp → reenvía el OTP a un contacto pendiente. */
  resend(contactId: string): Promise<void>;
  /** DELETE /contacts/:id → elimina un contacto (cool-down de 24 h en el bff). */
  remove(contactId: string): Promise<void>;
}
