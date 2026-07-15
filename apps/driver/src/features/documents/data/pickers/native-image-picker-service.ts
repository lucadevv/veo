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
} from '../../domain/ports/image-picker-service';

/**
 * Implementación de `ImagePickerService` sobre `react-native-image-picker` (galería + cámara), para
 * la captura del binario de los documentos del alta.
 *
 * NATIVO: requiere `react-native-image-picker` instalado + `pod install` (iOS) + rebuild, los usage
 * strings de cámara/fototeca (iOS `Info.plist`: `NSCameraUsageDescription` + `NSPhotoLibraryUsageDescription`)
 * y el permiso de cámara (Android `AndroidManifest` — ya declarado). La galería usa el selector del
 * sistema (Android Photo Picker), por lo que no exige permiso de almacenamiento.
 *
 * Captura con cámara TRASERA (`back`): el conductor fotografía un documento físico, no su rostro
 * (a diferencia de la captura facial del KYC, que usa la frontal).
 */
export class NativeImagePickerService implements ImagePickerService {
  async pick(source: ImageSource, options?: ImagePickOptions): Promise<PickedImage | null> {
    const common = {
      mediaType: 'photo' as const,
      maxWidth: options?.maxWidth ?? 2048,
      maxHeight: options?.maxHeight ?? 2048,
      quality: (options?.quality ?? 0.85) as PhotoQuality,
      includeBase64: false,
    };

    const response =
      source === 'camera'
        ? await launchCamera({ ...common, saveToPhotos: false, cameraType: 'back' })
        : await launchImageLibrary({ ...common, selectionLimit: 1 });

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

/** Singleton del picker nativo de imágenes de documentos para inyectar en la capa de presentación. */
export const nativeImagePickerService: ImagePickerService = new NativeImagePickerService();
