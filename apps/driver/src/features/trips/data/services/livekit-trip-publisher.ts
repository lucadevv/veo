import {Room} from 'livekit-client';
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
    const room = new Room({adaptiveStream: true, dynacast: true});
    this.room = room;
    try {
      // 2) Conexión a la sala del viaje con el token de publicación.
      await room.connect(credentials.url, credentials.token);
      // 3) Captura real de cámara + micrófono y publicación en la sala.
      await room.localParticipant.enableCameraAndMicrophone();
      this.publishing = true;
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
