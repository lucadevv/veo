/**
 * Preferencia de "quién puede ver la cámara del habitáculo" (Ola 2A · seguridad/privacidad).
 *
 * HUECO DE BACKEND DOCUMENTADO: a la fecha NO existe endpoint soberano (ni en `@veo/api-client`
 * `mobile.ts`, ni en `public-bff`) para LEER/ESCRIBIR quién ve la cámara. El grant de video
 * (`GET /trips/:id/video` → `TripVideoGrant`) es solo del PASAJERO (token `canSubscribe`); no hay
 * un contrato para autorizar a contactos a suscribirse al room del viaje.
 *
 * DEUDA: (backend) falta endpoint para persistir la preferencia "quién ve mi cámara" (p.ej. PUT /camera-share-prefs con contactos habilitados) y que media-service la aplique al autorizar viewers. Hoy la pref vive solo en MMKV local, no llega al backend.
 * DEGRADACIÓN HONESTA: la preferencia se persiste LOCALMENTE (MMKV, almacén `prefs`, no sensible).
 * La UI deja explícito que se aplicará cuando exista el servicio de compartir cámara (no simula que
 * ya se comparte). Cuando el backend exista, se reemplaza `LocalCameraSharePreferenceRepository` por
 * una implementación HTTP bajo el MISMO token de DI, sin tocar dominio ni presentación (DIP).
 */

/** Preferencia de compartir cámara del pasajero (modelo de dominio, desacoplado del transporte). */
export interface CameraSharePreference {
  /** Master: el pasajero habilita compartir la cámara con su familia. */
  shareWithFamily: boolean;
  /**
   * IDs de contactos de confianza autorizados a ver la cámara en vivo. Subconjunto de los contactos
   * VERIFICADOS (la UI solo lista verificados). Solo aplica cuando `shareWithFamily` está activo.
   */
  allowedContactIds: string[];
}

/** Preferencia por defecto (primera vez): compartir desactivado, sin contactos autorizados. */
export const DEFAULT_CAMERA_SHARE_PREFERENCE: CameraSharePreference = {
  shareWithFamily: false,
  allowedContactIds: [],
};

/**
 * Abstracción del repositorio de la preferencia de compartir cámara (DIP). La implementación actual
 * es LOCAL (MMKV) por el hueco de backend descrito arriba; la firma es asíncrona para que una futura
 * implementación HTTP encaje sin cambiar el contrato.
 */
export interface CameraSharePreferenceRepository {
  /** Lee la preferencia del pasajero para un viaje (o el default si nunca se guardó). */
  get(tripId: string): Promise<CameraSharePreference>;
  /** Persiste la preferencia del pasajero para un viaje. */
  save(tripId: string, preference: CameraSharePreference): Promise<void>;
}
