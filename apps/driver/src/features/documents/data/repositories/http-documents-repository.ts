import type {HttpClient} from '@veo/api-client';
import { addDocumentRequest, driverDocument} from '@veo/api-client';
import {z} from 'zod';
import type {
  DocumentsRepository,
  DriverDocument,
  DriverDocumentList,
  RegisterDocumentInput,
} from '../../domain';

/** Schema de la respuesta del listado: el endpoint devuelve un arreglo de `driverDocument`. */
const driverDocumentList = z.array(driverDocument);

/** Implementación HTTP del `DocumentsRepository` contra el driver-bff. */
export class HttpDocumentsRepository implements DocumentsRepository {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<DriverDocumentList> {
    return this.http.get('/drivers/me/documents', {schema: driverDocumentList});
  }

  register(input: RegisterDocumentInput): Promise<DriverDocument> {
    // Valida el body con el contrato antes de enviarlo (descarta campos no permitidos por "strip").
    const body = addDocumentRequest.parse(input);
    return this.http.post('/drivers/me/documents', {body, schema: driverDocument});
  }
}
