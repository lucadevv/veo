import {
  launchCamera,
  launchImageLibrary,
  type ImagePickerResponse,
  type PhotoQuality,
} from 'react-native-image-picker';
import {
  ImagePickError,
  type ImagePickOptions,
  type ImagePickerService,
  type ImageSource,
  type PickedImage,
} from '../domain/imagePickerService';

/**
 * Implementación de `ImagePickerService` sobre `react-native-image-picker` (galería + cámara).
 *
 * NATIVO: requiere `pod install` (iOS) + rebuild, y los usage strings de cámara/fototeca
 * (iOS `Info.plist`) y el permiso de cámara (Android `AndroidManifest`). La galería usa el selector
 * del sistema (Android Photo Picker), por lo que no exige permiso de almacenamiento.
 */
export class NativeImagePickerService implements ImagePickerService {
  async pick(
    source: ImageSource,
    options?: ImagePickOptions,
  ): Promise<PickedImage | null> {
    const common = {
      mediaType: 'photo' as const,
      maxWidth: options?.maxWidth ?? 1024,
      maxHeight: options?.maxHeight ?? 1024,
      quality: (options?.quality ?? 0.8) as PhotoQuality,
      includeBase64: false,
    };

    const response =
      source === 'camera'
        ? await launchCamera({
            ...common,
            saveToPhotos: false,
            cameraType: 'front',
          })
        : await launchImageLibrary({...common, selectionLimit: 1});

    return this.mapResponse(response);
  }

  /** Normaliza la respuesta del SDK al modelo de dominio; cancelar ⇒ `null`, fallos ⇒ `ImagePickError`. */
  private mapResponse(response: ImagePickerResponse): PickedImage | null {
    if (response.didCancel) {
      return null;
    }
    if (response.errorCode) {
      throw new ImagePickError(
        response.errorCode === 'permission'
          ? 'permission'
          : response.errorCode === 'camera_unavailable'
            ? 'unavailable'
            : 'unknown',
        response.errorMessage,
      );
    }

    const asset = response.assets?.[0];
    if (!asset?.uri) {
      return null;
    }
    return {
      uri: asset.uri,
      mimeType: asset.type ?? null,
      fileName: asset.fileName ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      fileSize: asset.fileSize ?? null,
    };
  }
}
