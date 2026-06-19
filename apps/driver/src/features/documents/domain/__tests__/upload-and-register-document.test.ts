import type { DriverDocument } from '@veo/api-client';
import type { RegisterDocumentInput } from '../entities';
import { DocumentUploadError, type DocumentUploader } from '../ports/document-uploader';
import type { PickedImage } from '../ports/image-picker-service';
import {
  UploadAndRegisterDocumentUseCase,
  type DocumentRegistrar,
} from '../usecases/upload-and-register-document';

const FILE: PickedImage = {
  uri: 'file:///tmp/license.jpg',
  mimeType: 'image/jpeg',
  fileName: 'license.jpg',
  width: 1024,
  height: 768,
  fileSize: 120_000,
};

function registeredDoc(): DriverDocument {
  return {
    type: 'LICENSE_A1',
    documentNumber: 'Q12345',
    status: 'PENDING',
    simpleStatus: 'en_revision',
    expiresAt: '2027-01-01T00:00:00.000Z',
    ok: true,
    rejectionReason: null,
  };
}

describe('UploadAndRegisterDocumentUseCase', () => {
  it('happy path: sube el binario y LUEGO registra con el fileS3Key devuelto', async () => {
    const created = registeredDoc();
    const upload = jest.fn(async () => ({ fileS3Key: 'drivers/d-1/license-abc.jpg' }));
    const register = jest.fn(async () => created);
    const uploader: DocumentUploader = { upload };
    const registrar: DocumentRegistrar = { register };

    const out = await new UploadAndRegisterDocumentUseCase(uploader, registrar).execute({
      type: 'LICENSE_A1',
      file: FILE,
      metadata: { documentNumber: 'Q12345', expiresAt: '2027-01-01T00:00:00.000Z' },
    });

    // El binario se sube con el tipo y el archivo elegidos.
    expect(upload).toHaveBeenCalledWith('LICENSE_A1', FILE);
    // El registro recibe la key REAL del binario subido + los metadatos del formulario.
    expect(register).toHaveBeenCalledWith({
      type: 'LICENSE_A1',
      documentNumber: 'Q12345',
      expiresAt: '2027-01-01T00:00:00.000Z',
      fileS3Key: 'drivers/d-1/license-abc.jpg',
    });
    expect(out).toBe(created);
  });

  it('omite expiresAt cuando el formulario no lo capturó (documento sin vencimiento)', async () => {
    const upload = jest.fn(async () => ({ fileS3Key: 'drivers/d-1/soat.png' }));
    const register = jest.fn(async (_input: RegisterDocumentInput) => registeredDoc());

    await new UploadAndRegisterDocumentUseCase({ upload }, { register }).execute({
      type: 'SOAT',
      file: FILE,
      metadata: { documentNumber: 'SOAT-99' },
    });

    expect(register).toHaveBeenCalledWith({
      type: 'SOAT',
      documentNumber: 'SOAT-99',
      fileS3Key: 'drivers/d-1/soat.png',
    });
    // Sin `expiresAt` en el body (no se envía undefined).
    const firstCall = register.mock.calls[0];
    expect(firstCall?.[0]).not.toHaveProperty('expiresAt');
  });

  it('si el PUT del binario falla, NUNCA registra el documento (sin éxito falso)', async () => {
    const upload = jest.fn(async () => {
      throw new DocumentUploadError('upload', 'El almacén de objetos respondió 403');
    });
    const register = jest.fn(async () => registeredDoc());
    const useCase = new UploadAndRegisterDocumentUseCase({ upload }, { register });

    await expect(
      useCase.execute({
        type: 'LICENSE_A1',
        file: FILE,
        metadata: { documentNumber: 'Q12345' },
      }),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'upload' });

    // El error de subida se propaga tal cual y el registro jamás se invoca.
    expect(register).not.toHaveBeenCalled();
  });

  it('propaga un fallo del registro tras una subida exitosa (el binario ya está, falla el POST)', async () => {
    const upload = jest.fn(async () => ({ fileS3Key: 'drivers/d-1/x.jpg' }));
    const register = jest.fn(async () => {
      throw new Error('HTTP 500');
    });
    const useCase = new UploadAndRegisterDocumentUseCase({ upload }, { register });

    await expect(
      useCase.execute({ type: 'SOAT', file: FILE, metadata: { documentNumber: 'S-1' } }),
    ).rejects.toThrow('HTTP 500');
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
