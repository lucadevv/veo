/**
 * Puertos del publisher de video/audio del habitáculo hacia LiveKit (self-hosted).
 *
 * Durante el viaje activo, el conductor publica cámara + micrófono a la sala del viaje para la
 * evidencia de seguridad (BR-S01). El transporte es el SDK LiveKit (`livekit-client` sobre los globals
 * de `react-native-webrtc`), igual patrón que el visor del pasajero.
 *
 * El TOKEN/URL de publisher lo emite el backend (media-service vía driver-bff):
 * `POST /media/rooms/:tripId/publisher-token` → `driverPublisherGrant` `{ url, token, room }`. El token
 * LiveKit se acuña con `canPublish: true`. El puerto `PublisherTokenPort` define la firma; la
 * implementación HTTP queda cableada contra el endpoint real.
 */

export interface PublisherCredentials {
  /** URL del servidor LiveKit (wss://…) al que se conecta el SDK. */
  url: string;
  /** Token LiveKit de publicación emitido por el backend (corta duración, `canPublish`). */
  token: string;
  /** Nombre de la sala del viaje devuelto por el backend. */
  room: string;
}

/**
 * Puerto del backend que entrega las credenciales de publicación de una sala de viaje.
 * Lo implementa `HttpPublisherTokenPort` contra el driver-bff.
 */
export interface PublisherTokenPort {
  /** Obtiene la URL + token LiveKit para publicar en la sala del viaje. */
  fetchPublisherCredentials(tripId: string): Promise<PublisherCredentials>;
}

export interface TripMediaPublisher {
  /** true mientras hay una publicación activa. */
  readonly isPublishing: boolean;
  /** Inicia la captura de cámara+micrófono y la publica en la sala `trip:<tripId>`. */
  start(tripId: string): Promise<void>;
  /** Detiene la publicación y libera la cámara/micrófono. */
  stop(): Promise<void>;
}

/** Código de error cuando el backend aún no expone el token de publisher. */
export const PUBLISHER_TOKEN_UNAVAILABLE = 'PUBLISHER_TOKEN_UNAVAILABLE';

/** Error claro (no un mock) cuando el endpoint de token de publisher no está disponible. */
export class PublisherTokenUnavailableError extends Error {
  readonly code = PUBLISHER_TOKEN_UNAVAILABLE;
  constructor(message = 'El backend no expone el token de publisher de la sala del viaje') {
    super(message);
    this.name = 'PublisherTokenUnavailableError';
  }
}

/** Código de error cuando el publisher nativo todavía no está instalado/cableado. */
export const TRIP_PUBLISHER_UNAVAILABLE = 'TRIP_PUBLISHER_UNAVAILABLE';

/** Error claro cuando el publisher nativo no está disponible. */
export class TripMediaPublisherUnavailableError extends Error {
  readonly code = TRIP_PUBLISHER_UNAVAILABLE;
  constructor() {
    super('Publisher de video del viaje no instalado');
    this.name = 'TripMediaPublisherUnavailableError';
  }
}

/**
 * Implementación por defecto: rechaza con un error claro hasta que la oleada nativa registre el
 * publisher real. No publica datos falsos ni silencia el fallo.
 */
export class UnavailableTripMediaPublisher implements TripMediaPublisher {
  readonly isPublishing = false;
  start(): Promise<void> {
    return Promise.reject(new TripMediaPublisherUnavailableError());
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}
