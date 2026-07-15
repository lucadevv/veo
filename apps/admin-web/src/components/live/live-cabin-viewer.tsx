'use client';

import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { Clock, Loader2, Video, VideoOff, X } from 'lucide-react';
import type { LiveViewerToken } from '@/lib/api/schemas';
import { Card } from '@/components/ui/card';

type VideoState = 'connecting' | 'live' | 'waiting' | 'reconnecting' | 'expired' | 'error';

/**
 * Viewer SOLO-RECEPCIÓN de la cabina en vivo vía LiveKit self-hosted (muro del admin). Usa exclusivamente
 * la url+token que entrega el bff (token solo-suscripción; no inventa credenciales). Si no hay stream o
 * falla, degrada a un estado tranquilo (nunca un error crudo). Portado del viewer verificado de family-web.
 */
export function LiveCabinViewer({
  grant,
  label,
  onClose,
}: {
  grant: LiveViewerToken;
  label: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<VideoState>('connecting');

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: false });
    let disposed = false;
    // El token es solo-suscripción y VENCE (grant.expiresInSeconds). Al vencer, LiveKit desconecta y antes esto
    // caía en 'waiting' ("esperando al conductor") — mentira: el ACCESO expiró. Marcamos el vencimiento explícito
    // para mostrar el estado honesto y ofrecer re-solicitar (nueva doble-auth), no un mensaje engañoso.
    let expired = false;
    const expiryMs = Math.max(0, grant.expiresInSeconds * 1000);
    const expiryTimer = setTimeout(() => {
      expired = true;
      if (!disposed) setState('expired');
      void room.disconnect();
    }, expiryMs);

    const attach = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
        if (!disposed) setState('live');
      }
    };

    const hasLiveVideo = () => {
      let has = false;
      room.remoteParticipants.forEach((p) =>
        p.trackPublications.forEach((pub) => {
          if (pub.track && pub.kind === Track.Kind.Video) {
            attach(pub.track);
            has = true;
          }
        }),
      );
      return has;
    };

    room
      .on(RoomEvent.TrackSubscribed, attach)
      .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
      // Corte transitorio de red: LiveKit reintenta solo → estado propio (no colapsar a 'waiting').
      .on(RoomEvent.Reconnecting, () => {
        if (!disposed && !expired) setState('reconnecting');
      })
      .on(RoomEvent.Reconnected, () => {
        if (!disposed && !expired) setState(hasLiveVideo() ? 'live' : 'waiting');
      })
      .on(RoomEvent.Disconnected, () => {
        // Desconexión terminal: si ya venció el token es 'expired' (honesto); si no, el conductor dejó de publicar.
        if (!disposed) setState(expired ? 'expired' : 'waiting');
      });

    void (async () => {
      try {
        await room.connect(grant.url, grant.token);
        if (disposed) return;
        if (!hasLiveVideo()) setState('waiting');
      } catch {
        if (!disposed) setState('error');
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(expiryTimer);
      void room.disconnect();
    };
  }, [grant.url, grant.token, grant.expiresInSeconds]);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h3 className="truncate text-sm font-medium text-ink">{label}</h3>
        <div className="flex items-center gap-3">
          {state === 'live' ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <Video className="size-4" aria-hidden />
              En vivo
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar cámara"
            className="text-ink-muted transition-colors hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="relative aspect-video w-full bg-surface-2">
        <video
          ref={videoRef}
          className={state === 'live' ? 'size-full object-cover' : 'hidden'}
          autoPlay
          muted
          playsInline
          aria-label="Cámara del habitáculo en vivo"
        />
        {state !== 'live' ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-xs text-sm text-ink-muted">
              {state === 'connecting' ? <p>Conectando con la cámara…</p> : null}
              {state === 'reconnecting' ? (
                <p className="flex flex-col items-center gap-2">
                  <Loader2 className="size-6 animate-spin text-ink-subtle" aria-hidden />
                  Reconectando con la cámara…
                </p>
              ) : null}
              {state === 'waiting' ? (
                <p>La cámara aparecerá cuando el conductor publique.</p>
              ) : null}
              {state === 'expired' ? (
                <span className="flex flex-col items-center gap-2">
                  <Clock className="size-6 text-warn" aria-hidden />
                  <span className="text-ink">La sesión de video expiró.</span>
                  <span className="text-xs">Cerrá y volvé a solicitar acceso (nueva doble-auth).</span>
                  <button
                    type="button"
                    onClick={onClose}
                    className="mt-1 rounded-control border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
                  >
                    Cerrar
                  </button>
                </span>
              ) : null}
              {state === 'error' ? (
                <p className="flex flex-col items-center gap-2">
                  <VideoOff className="size-6 text-ink-subtle" aria-hidden />
                  No pudimos mostrar la cámara en este momento.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
