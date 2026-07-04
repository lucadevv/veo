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
    // Sub-lote 3A/3B: caras del documento ya subidas (1 imagen SINGLE para la licencia de este fixture).
    images: [{ side: 'SINGLE', order: 0, url: null }],
  };
}

/** Cara única (compat 1 imagen) construida sobre el `FILE` de prueba. */
const SINGLE = [{ side: 'SINGLE' as const, file: FILE }];

describe('UploadAndRegisterDocumentUseCase', () => {
  it('happy path: sube los binarios y LUEGO registra con las images devueltas', async () => {
    const created = registeredDoc();
    const upload = jest.fn(async () => ({
      images: [{ s3Key: 'drivers/d-1/license-abc.jpg', side: 'SINGLE' as const }],
    }));
    const register = jest.fn(async () => created);
    const uploader: DocumentUploader = { upload };
    const registrar: DocumentRegistrar = { register };

    const out = await new UploadAndRegisterDocumentUseCase(uploader, registrar).execute({
      type: 'LICENSE_A1',
      sides: SINGLE,
      metadata: { documentNumber: 'Q12345', expiresAt: '2027-01-01T00:00:00.000Z' },
    });

    // El binario se sube con el tipo y las caras elegidas (3er arg `onSidePhase` ausente ⇒ undefined).
    expect(upload).toHaveBeenCalledWith('LICENSE_A1', SINGLE, undefined);
    // El registro recibe las keys REALES de los binarios subidos (images) + los metadatos del formulario.
    expect(register).toHaveBeenCalledWith({
      type: 'LICENSE_A1',
      documentNumber: 'Q12345',
      expiresAt: '2027-01-01T00:00:00.000Z',
      images: [{ s3Key: 'drivers/d-1/license-abc.jpg', side: 'SINGLE' }],
    });
    expect(out).toBe(created);
  });

  it('DNI: sube FRONT+BACK y registra con images de las dos caras', async () => {
    const front: PickedImage = { ...FILE, uri: 'data:image/jpeg;base64,FRONT' };
    const back: PickedImage = { ...FILE, uri: 'data:image/jpeg;base64,BACK' };
    const dniSides = [
      { side: 'FRONT' as const, file: front },
      { side: 'BACK' as const, file: back },
    ];
    const upload = jest.fn(async () => ({
      images: [
        { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' as const },
        { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' as const },
      ],
    }));
    const register = jest.fn(async (_input: RegisterDocumentInput) => registeredDoc());

    await new UploadAndRegisterDocumentUseCase({ upload }, { register }).execute({
      type: 'DNI',
      sides: dniSides,
      metadata: { documentNumber: '70123456' },
    });

    // El uploader recibe AMBAS caras (FRONT + BACK) (3er arg `onSidePhase` ausente ⇒ undefined).
    expect(upload).toHaveBeenCalledWith('DNI', dniSides, undefined);
    // El registro lleva las dos imágenes con su cara correcta.
    expect(register).toHaveBeenCalledWith({
      type: 'DNI',
      documentNumber: '70123456',
      images: [
        { s3Key: 'drivers/d-1/dni-front.jpg', side: 'FRONT' },
        { s3Key: 'drivers/d-1/dni-back.jpg', side: 'BACK' },
      ],
    });
  });

  it('omite expiresAt cuando el formulario no lo capturó (documento sin vencimiento)', async () => {
    const upload = jest.fn(async () => ({
      images: [{ s3Key: 'drivers/d-1/soat.png', side: 'SINGLE' as const }],
    }));
    const register = jest.fn(async (_input: RegisterDocumentInput) => registeredDoc());

    await new UploadAndRegisterDocumentUseCase({ upload }, { register }).execute({
      type: 'SOAT',
      sides: SINGLE,
      metadata: { documentNumber: 'SOAT-99' },
    });

    expect(register).toHaveBeenCalledWith({
      type: 'SOAT',
      documentNumber: 'SOAT-99',
      images: [{ s3Key: 'drivers/d-1/soat.png', side: 'SINGLE' }],
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
        sides: SINGLE,
        metadata: { documentNumber: 'Q12345' },
      }),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'upload' });

    // El error de subida se propaga tal cual y el registro jamás se invoca.
    expect(register).not.toHaveBeenCalled();
  });

  it('propaga un fallo del registro tras una subida exitosa (el binario ya está, falla el POST)', async () => {
    const upload = jest.fn(async () => ({
      images: [{ s3Key: 'drivers/d-1/x.jpg', side: 'SINGLE' as const }],
    }));
    const register = jest.fn(async () => {
      throw new Error('HTTP 500');
    });
    const useCase = new UploadAndRegisterDocumentUseCase({ upload }, { register });

    await expect(
      useCase.execute({ type: 'SOAT', sides: SINGLE, metadata: { documentNumber: 'S-1' } }),
    ).rejects.toThrow('HTTP 500');
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
