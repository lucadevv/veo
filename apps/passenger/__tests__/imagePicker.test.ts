import type { ImagePickerResponse } from 'react-native-image-picker';
import { NativeImagePickerService } from '../src/shared/media/data/nativeImagePickerService';
import { ImagePickError } from '../src/shared/media/domain/imagePickerService';

// Mock del SDK nativo: controlamos la respuesta por test (cancelar / error / éxito).
// El prefijo `mock` es obligatorio para referenciarlas dentro del factory de `jest.mock`.
const mockLaunchCamera = jest.fn();
const mockLaunchImageLibrary = jest.fn();
jest.mock('react-native-image-picker', () => ({
  __esModule: true,
  launchCamera: (...args: unknown[]) => mockLaunchCamera(...args),
  launchImageLibrary: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

describe('NativeImagePickerService · mapeo de la respuesta del SDK', () => {
  const service = new NativeImagePickerService();

  beforeEach(() => {
    mockLaunchCamera.mockReset();
    mockLaunchImageLibrary.mockReset();
  });

  it('devuelve null cuando el usuario cancela', async () => {
    mockLaunchImageLibrary.mockResolvedValue({ didCancel: true } satisfies ImagePickerResponse);
    await expect(service.pick('library')).resolves.toBeNull();
  });

  it('lanza ImagePickError(permission) ante permiso denegado', async () => {
    mockLaunchCamera.mockResolvedValue({
      errorCode: 'permission',
      errorMessage: 'denied',
    } satisfies ImagePickerResponse);
    await expect(service.pick('camera')).rejects.toMatchObject({ reason: 'permission' });
    await expect(service.pick('camera')).rejects.toBeInstanceOf(ImagePickError);
  });

  it('lanza ImagePickError(unavailable) si la cámara no está disponible', async () => {
    mockLaunchCamera.mockResolvedValue({
      errorCode: 'camera_unavailable',
    } satisfies ImagePickerResponse);
    await expect(service.pick('camera')).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('mapea el asset elegido al modelo de dominio', async () => {
    mockLaunchImageLibrary.mockResolvedValue({
      assets: [
        {
          uri: 'file:///tmp/avatar.jpg',
          type: 'image/jpeg',
          fileName: 'avatar.jpg',
          width: 800,
          height: 800,
          fileSize: 12345,
        },
      ],
    } satisfies ImagePickerResponse);

    const picked = await service.pick('library');
    expect(picked).toEqual({
      uri: 'file:///tmp/avatar.jpg',
      mimeType: 'image/jpeg',
      fileName: 'avatar.jpg',
      width: 800,
      height: 800,
      fileSize: 12345,
    });
  });

  it('devuelve null si el SDK no entrega assets utilizables', async () => {
    mockLaunchImageLibrary.mockResolvedValue({ assets: [] } satisfies ImagePickerResponse);
    await expect(service.pick('library')).resolves.toBeNull();
  });
});
