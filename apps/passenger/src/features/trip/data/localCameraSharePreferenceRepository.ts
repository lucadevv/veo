import type { KeyValueStore } from '../../../core/storage/mmkv';
import {
  DEFAULT_CAMERA_SHARE_PREFERENCE,
  type CameraSharePreference,
  type CameraSharePreferenceRepository,
} from '../domain/cameraShareRepository';

/** Prefijo de la clave por viaje en MMKV (prefs, NO el almacén seguro: no es dato sensible). */
const KEY_PREFIX = 'cameraShare.pref.';

/**
 * Preferencia de compartir cámara persistida LOCALMENTE en MMKV (prefs). Implementación de
 * DEGRADACIÓN HONESTA mientras no exista el servicio soberano de "quién ve la cámara" (ver
 * `cameraShareRepository.ts`). Sin red: lee/escribe la elección del pasajero por viaje. Determinista
 * y testeable inyectando un `KeyValueStore` en memoria. Cuando exista el backend, se sustituye por una
 * impl HTTP bajo el mismo token de DI, sin tocar dominio ni presentación.
 */
export class LocalCameraSharePreferenceRepository
  implements CameraSharePreferenceRepository
{
  constructor(private readonly store: KeyValueStore) {}

  private keyFor(tripId: string): string {
    return `${KEY_PREFIX}${tripId}`;
  }

  get(tripId: string): Promise<CameraSharePreference> {
    const stored = this.store.getJSON<CameraSharePreference>(this.keyFor(tripId));
    if (!stored) {
      return Promise.resolve({ ...DEFAULT_CAMERA_SHARE_PREFERENCE, allowedContactIds: [] });
    }
    // Normaliza un valor potencialmente parcial/corrupto para no propagar shapes inválidos a la UI.
    return Promise.resolve({
      shareWithFamily: Boolean(stored.shareWithFamily),
      allowedContactIds: Array.isArray(stored.allowedContactIds)
        ? stored.allowedContactIds.filter((id): id is string => typeof id === 'string')
        : [],
    });
  }

  save(tripId: string, preference: CameraSharePreference): Promise<void> {
    this.store.setJSON<CameraSharePreference>(this.keyFor(tripId), {
      shareWithFamily: preference.shareWithFamily,
      // Si el master está apagado, no persistimos contactos autorizados (coherencia: nadie ve la cámara).
      allowedContactIds: preference.shareWithFamily ? preference.allowedContactIds : [],
    });
    return Promise.resolve();
  }
}
