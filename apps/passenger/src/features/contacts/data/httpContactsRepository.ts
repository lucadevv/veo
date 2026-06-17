import {
  addContactResult,
  contactResource,
  contactView,
  type HttpClient,
  resendContactOtpResult,
} from '@veo/api-client';
import type {ContactsRepository} from '../domain/contactsRepository';
import type {NewTrustedContact, TrustedContact} from '../domain/entities';

/**
 * Implementación REAL de `ContactsRepository` contra el public-bff (`/contacts`, BR-I06).
 *
 * Valida cada respuesta con los schemas SOBERANOS de `@veo/api-client` (`contactView` para el
 * listado, `contactResource`/`addContactResult` para los comandos, `resendContactOtpResult` para el
 * reenvío). No se duplican contratos: son la fuente de verdad compartida con el bff.
 */
const contactListSchema = contactView.array();

export class HttpContactsRepository implements ContactsRepository {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<TrustedContact[]> {
    return this.http.get('/contacts', {schema: contactListSchema});
  }

  async add(input: NewTrustedContact): Promise<TrustedContact> {
    const result = await this.http.post('/contacts', {
      body: input,
      schema: addContactResult,
    });
    return result.contact;
  }

  verify(contactId: string, code: string): Promise<TrustedContact> {
    return this.http.post(`/contacts/${contactId}/verify-otp`, {
      body: {code},
      schema: contactResource,
    });
  }

  async resend(contactId: string): Promise<void> {
    await this.http.post(`/contacts/${contactId}/resend-otp`, {
      schema: resendContactOtpResult,
    });
  }

  async remove(contactId: string): Promise<void> {
    // DELETE 204: el HttpClient resuelve undefined; no hay cuerpo que validar.
    await this.http.delete(`/contacts/${contactId}`);
  }
}
