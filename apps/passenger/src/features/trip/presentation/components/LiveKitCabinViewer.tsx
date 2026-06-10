import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from 'livekit-client';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { MediaStream, RTCView } from 'react-native-webrtc';
import type { CabinVideoViewerProps } from '../ports/cabinVideoViewer';

/**
 * Visor REAL del video del habitáculo (BR de seguridad) sobre LiveKit self-hosted.
 *
 * Solo RECEPCIÓN: usa el `TripVideoGrant` (url + token) que entrega `GET /trips/:id/video`. El token
 * lo acuña el bff con `canSubscribe: true / canPublish: false`, así que esta app nunca publica.
 *
 * Implementación: `livekit-client` (OSS) corriendo sobre los globals WebRTC de `react-native-webrtc`
 * (registrados en el bootstrap nativo). El track de video remoto se renderiza con `RTCView`.
 */
/** Reintentos de conexión ante un fallo duro de `room.connect` antes de reportar 'error'. */
const MAX_CONNECT_ATTEMPTS = 3;
/** Espera base entre reintentos (backoff lineal: 1s, 2s, 3s). */
const RETRY_DELAY_MS = 1000;

export function LiveKitCabinViewer({
  grant,
  onStateChange,
}: CabinVideoViewerProps): React.JSX.Element {
  const [streamURL, setStreamURL] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    onStateChange?.('connecting');

    // `adaptiveStream` ajusta la calidad recibida; `dynacast` no aplica al ser solo suscriptor.
    const room = new Room({ adaptiveStream: true });

    const attachVideo = (track: RemoteTrack): void => {
      if (track.kind !== Track.Kind.Video) {
        return;
      }
      // `mediaStreamTrack` es, en runtime, un track de react-native-webrtc (globals registrados).
      const rtcTrack = track.mediaStreamTrack as unknown as MediaStreamTrack;
      const stream = new MediaStream([rtcTrack as never]);
      if (!cancelled) {
        setStreamURL(stream.toURL());
        onStateChange?.('live');
      }
    };

    room
      .on(RoomEvent.TrackSubscribed, (track) => attachVideo(track))
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Video && !cancelled) {
          // La pista se cayó: volvemos a "conectando" en vez de dejar un panel en blanco mudo.
          setStreamURL(null);
          onStateChange?.('connecting');
        }
      });

    const tryConnect = (): void => {
      if (cancelled) {
        return;
      }
      attempt += 1;
      void room.connect(grant.url, grant.token).catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (attempt < MAX_CONNECT_ATTEMPTS) {
          // Reintento con backoff: un corte transitorio no debe matar la vista en vivo en silencio.
          onStateChange?.('connecting');
          retryTimer = setTimeout(tryConnect, RETRY_DELAY_MS * attempt);
        } else {
          // Agotados los reintentos: el panel muestra "video no disponible" (no se inventan credenciales).
          console.warn('[cabin-video] no se pudo conectar a LiveKit:', error);
          onStateChange?.('error');
        }
      });
    };
    tryConnect();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      void room.disconnect();
    };
  }, [grant.url, grant.token, onStateChange]);

  if (!streamURL) {
    // Conectando / aún sin pista de video: el contenedor del panel ya muestra el indicador REC.
    return <View style={styles.fill} />;
  }

  return <RTCView streamURL={streamURL} style={styles.fill} objectFit="cover" />;
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
});
