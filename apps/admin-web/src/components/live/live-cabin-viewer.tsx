'use client';

import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { Video, VideoOff, X } from 'lucide-react';
import type { LiveViewerToken } from '@/lib/api/schemas';
import { Card } from '@/components/ui/card';

type VideoState = 'connecting' | 'live' | 'waiting' | 'error';

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

    const attach = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
        if (!disposed) setState('live');
      }
    };

    room
      .on(RoomEvent.TrackSubscribed, attach)
      .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
      .on(RoomEvent.Disconnected, () => {
        if (!disposed) setState('waiting');
      });

    void (async () => {
      try {
        await room.connect(grant.url, grant.token);
        if (disposed) return;
        let hasVideo = false;
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((pub) => {
            if (pub.track && pub.kind === Track.Kind.Video) {
              attach(pub.track);
              hasVideo = true;
            }
          });
        });
        if (!hasVideo) setState('waiting');
      } catch {
        if (!disposed) setState('error');
      }
    })();

    return () => {
      disposed = true;
      void room.disconnect();
    };
  }, [grant.url, grant.token]);

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
            className="text-ink-muted transition-colors hover:text-ink">
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
              {state === 'waiting' ? <p>La cámara aparecerá cuando el conductor publique.</p> : null}
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
