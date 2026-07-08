import type { PickedImage } from '../../../documents/domain/ports/image-picker-service';
import type { AvatarUploader } from '../ports/avatar-uploader';

/**
 * Sube la foto de perfil (avatar) elegida. Delega en el puerto `AvatarUploader` (subida prefirmada a
 * S3/MinIO); el confirm del driver-bff YA persiste la foto en el perfil (identity `User.photoUrl`), así
 * que este caso de uso NO necesita un PATCH aparte (a diferencia del pasajero). La presentación invalida
 * el query del perfil tras el éxito para refrescar la vista con la foto persistida. Devuelve la
 * `photoUrl` sellada por si la UI quiere pintarla optimista.
 */
export class UploadAvatarUseCase {
  constructor(private readonly uploader: AvatarUploader) {}

  execute(file: PickedImage): Promise<{ photoUrl: string }> {
    return this.uploader.uploadAvatar(file);
  }
}
