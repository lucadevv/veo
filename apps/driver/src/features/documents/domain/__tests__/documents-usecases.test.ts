import type { DriverDocument } from '@veo/api-client';
import type { DocumentsRepository } from '../repositories/documents-repository';
import {
  ListDocumentsUseCase,
  RegisterDocumentUseCase,
  countDocumentsNeedingAttention,
} from '../usecases/documents-usecases';

function doc(
  partial: Partial<DriverDocument> & Pick<DriverDocument, 'simpleStatus'>,
): DriverDocument {
  return {
    type: partial.type ?? 'SOAT',
    documentNumber: partial.documentNumber ?? '123',
    status: partial.status ?? 'VALID',
    simpleStatus: partial.simpleStatus,
    expiresAt: partial.expiresAt ?? null,
    ok: partial.ok ?? true,
  };
}

describe('documents use cases', () => {
  it('ListDocumentsUseCase ordena por urgencia (vencido primero, vigente al final)', async () => {
    const repo: DocumentsRepository = {
      list: async () => [
        doc({ type: 'A', simpleStatus: 'vigente' }),
        doc({ type: 'B', simpleStatus: 'vencido' }),
        doc({ type: 'C', simpleStatus: 'en_revision' }),
        doc({ type: 'D', simpleStatus: 'por_vencer' }),
        doc({ type: 'E', simpleStatus: 'rechazado' }),
      ],
      register: async () => doc({ simpleStatus: 'en_revision' }),
    };

    const result = await new ListDocumentsUseCase(repo).execute();
    expect(result.map((d) => d.type)).toEqual(['B', 'E', 'D', 'C', 'A']);
  });

  it('RegisterDocumentUseCase delega en el repositorio y devuelve el documento creado', async () => {
    const created = doc({ type: 'LICENSE_A1', simpleStatus: 'en_revision' });
    const register = jest.fn(async () => created);
    const repo: DocumentsRepository = { list: async () => [], register };

    const out = await new RegisterDocumentUseCase(repo).execute({
      type: 'LICENSE_A1',
      documentNumber: 'Q12345',
    });

    expect(register).toHaveBeenCalledWith({ type: 'LICENSE_A1', documentNumber: 'Q12345' });
    expect(out).toBe(created);
  });

  it('countDocumentsNeedingAttention cuenta vencidos/por vencer/rechazados', () => {
    const docs = [
      doc({ simpleStatus: 'vigente' }),
      doc({ simpleStatus: 'por_vencer' }),
      doc({ simpleStatus: 'vencido' }),
      doc({ simpleStatus: 'en_revision' }),
      doc({ simpleStatus: 'rechazado' }),
    ];
    expect(countDocumentsNeedingAttention(docs)).toBe(3);
  });
});
