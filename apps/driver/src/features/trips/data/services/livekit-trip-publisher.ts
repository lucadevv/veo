import { Room } from 'livekit-client';
import { mediaDevices } from 'react-native-webrtc';
import type {
  PublisherTokenPort,
  TripMediaPublisher,
} from '../../domain/ports/trip-media-publisher';

/**
 * Publisher de cámara+micrófono del habitáculo hacia LiveKit (self-hosted) usando el SDK
 * `livekit-client` sobre los globals de `react-native-webrtc` (registrados en el arranque nativo).
 *
 * Mismo patrón que el visor del pasajero, pero del lado de PUBLICACIÓN: el token lo acuña el backend
 * con `canPublish: true` (`POST /media/rooms/:tripId/publisher-token`). Flujo:
 *  1. Pide credenciales `{ url, token, room }` al backend (`PublisherTokenPort`).
 *  2. Conecta la `Room` a `url` con `token`.
 *  3. Publica cámara + micrófono reales (`enableCameraAndMicrophone`) en la sala del viaje.
 *
 * No es un mock: la captura y la negociación WebRTC son reales. Si el backend no entrega credenciales,
 * se propaga el error claro del puerto de token (no se inventan credenciales).
 */
/**
 * ¿Hay al menos una cámara (`videoinput`) disponible? react-native-webrtc `enumerateDevices` NO requiere
 * permiso para exponer el `kind` de cada dispositivo (el label sí). En el simulador iOS no hay videoinput.
 * Tolerante a fallo: cualquier error al enumerar se trata como "sin cámara" (degradar > crashear).
 */
async function hasVideoInput(): Promise<boolean> {
  try {
    const devices = (await mediaDevices.enumerateDevices()) as Array<{ kind?: string }>;
    return Array.isArray(devices) && devices.some((d) => d.kind === 'videoinput');
  } catch {
    return false;
  }
}

export class LiveKitTripPublisher implements TripMediaPublisher {
  private room: Room | null = null;
  private publishing = false;

  constructor(private readonly tokenPort: PublisherTokenPort) {}

  get isPublishing(): boolean {
    return this.publishing;
  }

  async start(tripId: string): Promise<void> {
    if (this.publishing) {
      return;
    }
    // 1) Credenciales LiveKit del backend (lanza error claro si el endpoint falla).
    const credentials = await this.tokenPort.fetchPublisherCredentials(tripId);

    // `adaptiveStream`/`dynacast` mejoran el envío sobre redes móviles variables.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    try {
      // 2) Conexión a la sala del viaje con el token de publicación.
      await room.connect(credentials.url, credentials.token);
      // 3) GUARD anti-crash: capturar cámara en un entorno SIN cámara (simulador iOS, o device sin cámara)
      // hace que react-native-webrtc lance una excepción NATIVA que BYPASA el try/catch de JS → cierra el
      // app entero (crash al "Iniciar viaje"). Verificamos que exista un `videoinput` ANTES de publicar; si
      // no hay, degradamos honesto (NO publicamos video de cabina) en vez de crashear. La cámara de cabina
      // es un feature de SEGURIDAD que exige hardware real → en un dispositivo real con cámara publica normal.
      if (await hasVideoInput()) {
        await room.localParticipant.enableCameraAndMicrophone();
        this.publishing = true;
      } else if (__DEV__) {
        console.warn(
          '[VEO] Sin cámara disponible (¿simulador?): se omite la publicación de video de cabina para no ' +
            'crashear la app. En un dispositivo real con cámara se publica normalmente.',
        );
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.publishing = false;
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
  }
}
