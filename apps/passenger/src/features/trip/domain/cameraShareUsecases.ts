import type {
  CameraSharePreference,
  CameraSharePreferenceRepository,
} from './cameraShareRepository';

/**
 * Casos de uso de la preferencia de compartir cámara (Ola 2A · CameraControl). Orquestan el
 * repositorio de la preferencia (hoy LOCAL por hueco de backend; ver `cameraShareRepository.ts`).
 */

/** Lee la preferencia de compartir cámara del pasajero para un viaje. */
export class GetCameraSharePreferenceUseCase {
  constructor(private readonly repository: CameraSharePreferenceRepository) {}

  execute(tripId: string): Promise<CameraSharePreference> {
    return this.repository.get(tripId);
  }
}

/**
 * Guarda la preferencia de compartir cámara. Refuerza la invariante de coherencia: si el master
 * (`shareWithFamily`) está apagado, no se autoriza a ningún contacto (la regla la repite el repo al
 * persistir; aquí se vuelve explícita para que la UI no dependa del detalle de almacenamiento).
 */
export class SaveCameraSharePreferenceUseCase {
  constructor(private readonly repository: CameraSharePreferenceRepository) {}

  execute(tripId: string, preference: CameraSharePreference): Promise<void> {
    const normalized: CameraSharePreference = preference.shareWithFamily
      ? preference
      : { shareWithFamily: false, allowedContactIds: [] };
    return this.repository.save(tripId, normalized);
  }
}
